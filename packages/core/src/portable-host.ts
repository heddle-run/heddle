/**
 * The engine facade a JavaScriptCore host evaluates.
 *
 * This is the entry `scripts/build-portable.mjs` bundles into
 * `heddle-engine.js`. Everything it may touch on the host side, and
 * everything it must define, is written down in
 * `apps/HeddleCore/Sources/HeddleCore/Engine/CONTRACT.md` — change that file
 * first, then both sides.
 *
 * The shape throughout: the host is a set of dumb primitives (`__host_*`),
 * and every heddle decision — turns, suspensions, capability grants, frame
 * vocabulary — happens here, in the same modules the CLI and server run. A
 * phone and a server disagreeing about what a session is would be a bug this
 * file exists to make impossible.
 */
import { parseFlowObject, parseFlowYaml } from './spec/parser.js';
import { propertyTitle } from './spec/types.js';
import type { LLMConfig, ParsedFlow, StartNode } from './spec/types.js';
import { compile } from './graph/compile.js';
import { validate } from './graph/validate.js';
import { Runner } from './runner/runner.js';
import { DEFAULT_RUNNER_OPTIONS, type RunnerOptions } from './runner/options.js';
import { EVENT_CONTRACT_VERSION, type Event } from './runner/events.js';
import { serializeEvent } from './plugin/encoder.js';
import {
  evaluateLinked,
  linkEntry,
  usesModuleSyntax,
} from './plugin/esm-link.js';
import { PluginRegistry } from './plugin/registry.js';
import { servePlugin } from './plugin/serve-local.js';
import { validateManifest } from './plugin/manifest.js';
import { MiddlewareChain } from './plugin/middleware.js';
import { isSuspended } from './session/suspend.js';
import { resumeInputs } from './session/suspend.js';
import { closeTurn, openTurn, resumeTurn, type TurnOutcome } from './session/turn.js';
import { checkpointSink, positionOf } from './session/checkpoint.js';
import { withoutReserved } from './session/reserved.js';
import type { SessionStore } from './session/store.js';
import type {
  Checkpoint,
  ListOptions,
  SessionRecord,
  SessionSummary,
  Turn,
} from './session/types.js';
import type { Dependencies } from './node/types.js';
import type { Workspace } from './workspace/types.js';
import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  Provider,
  ToolCall,
  ToolCallDelta,
} from './llm/types.js';
import type { ProviderOptions } from './llm/provider.js';
import { envRefKey, isEnvRef } from './llm/env-refs.js';
import { LLMError, messageOf, PluginError, SessionConflictError } from './errors.js';

declare const __HEDDLE_CORE_VERSION__: string | undefined;

// ---------------------------------------------------------------------------
// What the host installed. Read once, loosely typed at the boundary: the
// contract file is the type.

type HostFns = {
  __host_emit(runId: string, frameLine: string): void;
  __host_runEnded(runId: string): void;
  __host_fetchStart(id: string, request: unknown): void;
  __host_fetchAbort(id: string): void;
  __host_resolveEnv(name: string): string | null;
  __host_sessionRead(id: string): string | null;
  __host_sessionWrite(id: string, json: string): void;
  __host_readFile(path: string): string | null;
  __host_writeFile(path: string, contents: string): boolean;
  __host_listDir(path: string): string[] | null;
};

const host = globalThis as unknown as HostFns;

// ---------------------------------------------------------------------------
// Polyfills: what bare JavaScriptCore lacks and the engine assumes. A host
// that already has them wins — these fill gaps, they do not replace.

installAbortPolyfill();

function installAbortPolyfill(): void {
  const g = globalThis as Record<string, unknown>;

  if (typeof g.AbortController !== 'function') {
    class PolyfillSignal {
      aborted = false;
      reason: unknown = undefined;
      onabort: ((this: unknown, ev: unknown) => void) | null = null;
      private listeners: Array<() => void> = [];

      addEventListener(type: string, listener: () => void): void {
        if (type === 'abort') this.listeners.push(listener);
      }
      removeEventListener(type: string, listener: () => void): void {
        if (type !== 'abort') return;
        this.listeners = this.listeners.filter((entry) => entry !== listener);
      }
      throwIfAborted(): void {
        if (this.aborted) throw this.reason;
      }
      /** @internal */
      dispatchAbort(reason: unknown): void {
        if (this.aborted) return;
        this.aborted = true;
        this.reason = reason;
        this.onabort?.call(this, { type: 'abort' });
        for (const listener of [...this.listeners]) listener();
      }
    }

    class PolyfillController {
      readonly signal = new PolyfillSignal();
      abort(reason?: unknown): void {
        this.signal.dispatchAbort(reason ?? abortError('This operation was aborted'));
      }
    }

    g.AbortController = PolyfillController;
    g.AbortSignal = PolyfillSignal;
  }

  const Signal = g.AbortSignal as {
    timeout?: (ms: number) => AbortSignal;
    any?: (signals: AbortSignal[]) => AbortSignal;
  };
  const Controller = g.AbortController as new () => AbortController;

  Signal.timeout ??= (ms: number): AbortSignal => {
    const controller = new Controller();
    setTimeout(
      () => controller.abort(abortError(`The operation timed out after ${ms}ms`)),
      ms,
    );
    return controller.signal;
  };

  Signal.any ??= (signals: AbortSignal[]): AbortSignal => {
    const controller = new Controller();
    for (const signal of signals) {
      if (signal.aborted) {
        controller.abort(signal.reason);
        break;
      }
      signal.addEventListener('abort', () => controller.abort(signal.reason));
    }
    return controller.signal;
  };
}

function abortError(message: string): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

// ---------------------------------------------------------------------------
// The fetch bridge. The host streams response text back through the
// `__engine_fetch*` callbacks; this side turns that into either a buffered
// body or per-chunk delivery. Text only, which is what model APIs speak.

interface FetchExchange {
  onResponse: (status: number, headers: Record<string, string>) => void;
  onChunk?: (chunk: string) => void;
  body: string;
  onEnd: () => void;
  onError: (message: string) => void;
}

const exchanges = new Map<string, FetchExchange>();
let nextFetchId = 0;

interface HostFetchOptions {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  signal?: AbortSignal;
  /** When given, chunks stream here and the resolved body is empty. */
  onChunk?: (chunk: string) => void;
}

interface HostFetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function hostFetch(options: HostFetchOptions): Promise<HostFetchResult> {
  return new Promise((resolve, reject) => {
    const id = `f${nextFetchId++}`;
    let status = 0;
    let headers: Record<string, string> = {};

    const exchange: FetchExchange = {
      onResponse: (gotStatus, gotHeaders) => {
        status = gotStatus;
        headers = gotHeaders;
      },
      onChunk: options.onChunk,
      body: '',
      onEnd: () => {
        exchanges.delete(id);
        resolve({ status, headers, body: exchange.body });
      },
      onError: (message) => {
        exchanges.delete(id);
        reject(new Error(message));
      },
    };
    exchanges.set(id, exchange);

    if (options.signal) {
      const abort = (): void => {
        host.__host_fetchAbort(id);
        exchange.onError('The request was aborted');
      };
      if (options.signal.aborted) {
        abort();
        return;
      }
      options.signal.addEventListener('abort', abort);
    }

    host.__host_fetchStart(id, {
      url: options.url,
      method: options.method,
      headers: options.headers,
      body: options.body,
    });
  });
}

(globalThis as Record<string, unknown>).__engine_fetchResponse = (
  id: string,
  meta: { status: number; headers: Record<string, string> },
): void => {
  exchanges.get(id)?.onResponse(meta.status, meta.headers ?? {});
};
(globalThis as Record<string, unknown>).__engine_fetchChunk = (
  id: string,
  chunk: string,
): void => {
  const exchange = exchanges.get(id);
  if (!exchange) return;
  if (exchange.onChunk) exchange.onChunk(chunk);
  else exchange.body += chunk;
};
(globalThis as Record<string, unknown>).__engine_fetchEnd = (id: string): void => {
  exchanges.get(id)?.onEnd();
};
(globalThis as Record<string, unknown>).__engine_fetchError = (
  id: string,
  message: string,
): void => {
  exchanges.get(id)?.onError(message);
};

// ---------------------------------------------------------------------------
// The model provider: core's builtin OpenAI-compatible client, re-spoken
// over the raw fetch bridge instead of the SDK. Request and response shapes
// mirror `llm/openai.ts` — when the two disagree, that file is right.

const OPENAI_COMPATIBLE_TYPES = new Set([
  'OpenAiConfig',
  'OpenAiCompatibleConfig',
  'VllmConfig',
  'OllamaConfig',
]);

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_KEY_ENV = 'OPENAI_API_KEY';

function portableCreateProvider(
  config: LLMConfig,
  options: ProviderOptions = {},
): Provider {
  const configType = config.componentType ?? 'OpenAiConfig';
  if (!OPENAI_COMPATIBLE_TYPES.has(configType)) {
    throw new LLMError(
      `unsupported config type "${configType}". ` +
        `Supported: ${[...OPENAI_COMPATIBLE_TYPES].join(', ')}`,
    );
  }

  const baseURL = (config.url ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const apiKey = resolveApiKey(config, options.allowEnvRefs ?? true);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  return {
    async chatCompletion(signal, chatRequest): Promise<ChatResponse> {
      const result = await hostFetch({
        url: `${baseURL}/chat/completions`,
        method: 'POST',
        headers,
        body: JSON.stringify(buildRequestBody(chatRequest)),
        signal,
      });
      assertOk(result);

      const completion = parseJson(result.body);
      const choice = (completion as { choices?: unknown[] }).choices?.[0];
      if (!choice) throw new LLMError('no choices in response');
      return toResponse(choice as CompletionChoice);
    },

    chatCompletionStream(signal, chatRequest): AsyncIterable<ChatChunk> {
      return streamCompletion(
        `${baseURL}/chat/completions`,
        headers,
        { ...buildRequestBody(chatRequest), stream: true },
        signal,
      );
    },
  };
}

/**
 * The key, resolved through the host's secret store.
 *
 * `$ENV` refs go where every portable env question goes: `__host_resolveEnv`,
 * never a `process.env` this context does not have. A config with no key at
 * all falls back to the conventional name, matching what the SDK would have
 * read off a machine's environment.
 */
function resolveApiKey(config: LLMConfig, allowEnvRefs: boolean): string {
  const declared = config.apiKey;

  if (declared !== undefined) {
    if (!isEnvRef(declared)) return declared;
    if (!allowEnvRefs) {
      throw new LLMError(
        `this host does not dereference environment variables from a spec ` +
          `("${declared}")`,
      );
    }
    return envValue(envRefKey(declared), declared);
  }

  return envValue(DEFAULT_KEY_ENV, undefined);
}

function envValue(name: string, ref: string | undefined): string {
  const value = host.__host_resolveEnv(name);
  if (value) return value;
  throw new LLMError(
    `environment variable "${name}" is not set` +
      (ref ? ` (referenced as "${ref}" in spec)` : ` and the flow names no api_key`) +
      `. On this device, keys live in Settings.`,
  );
}

interface CompletionChoice {
  message: {
    content?: string | null;
    tool_calls?: Array<{
      id: string;
      function: { name: string; arguments: string };
    }>;
  };
  finish_reason?: string | null;
}

interface StreamChoice {
  delta: {
    content?: string | null;
    tool_calls?: Array<{
      index: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason?: string | null;
}

function buildRequestBody(request: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map((message) => {
      if (message.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: message.tool_call_id,
          content: message.content,
        };
      }
      if (
        message.role === 'assistant' &&
        message.tool_calls &&
        message.tool_calls.length > 0
      ) {
        return {
          role: 'assistant',
          content: message.content,
          tool_calls: message.tool_calls.map((call: ToolCall) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          })),
        };
      }
      return { role: message.role, content: message.content };
    }),
  };

  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
  if (request.topP !== undefined) body.top_p = request.topP;
  if (request.responseFormat === 'json') {
    body.response_format = { type: 'json_object' };
  }

  return body;
}

function toResponse(choice: CompletionChoice): ChatResponse {
  const response: ChatResponse = {
    content: choice.message.content ?? '',
    finish_reason: choice.finish_reason ?? '',
  };
  const toolCalls = choice.message.tool_calls ?? [];
  if (toolCalls.length > 0) {
    response.tool_calls = toolCalls.map(
      (call): ToolCall => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      }),
    );
  }
  return response;
}

async function* streamCompletion(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
): AsyncGenerator<ChatChunk> {
  const queue: ChatChunk[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  let failure: unknown;
  let sawChoice = false;
  let buffer = '';

  const nudge = (): void => {
    wake?.();
    wake = undefined;
  };

  const acceptLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (payload === '' || payload === '[DONE]') return;

    let parsed: { choices?: StreamChoice[] };
    try {
      parsed = JSON.parse(payload) as { choices?: StreamChoice[] };
    } catch {
      return;
    }
    const choice = parsed.choices?.[0];
    if (!choice) return;
    sawChoice = true;

    const chunk: ChatChunk = {};
    if (choice.delta.content) chunk.content = choice.delta.content;
    const toolCalls = choice.delta.tool_calls ?? [];
    if (toolCalls.length > 0) {
      chunk.tool_calls = toolCalls.map((call): ToolCallDelta => {
        const delta: ToolCallDelta = { index: call.index };
        if (call.id) delta.id = call.id;
        if (call.function?.name) delta.name = call.function.name;
        if (typeof call.function?.arguments === 'string') {
          delta.arguments = call.function.arguments;
        }
        return delta;
      });
    }
    if (choice.finish_reason) chunk.finish_reason = choice.finish_reason;

    if (
      chunk.content !== undefined ||
      chunk.tool_calls !== undefined ||
      chunk.finish_reason !== undefined
    ) {
      queue.push(chunk);
      nudge();
    }
  };

  const call = hostFetch({
    url,
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
    onChunk: (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) acceptLine(line);
    },
  }).then(
    (result) => {
      try {
        if (buffer.length > 0) acceptLine(buffer);
        assertOk({ ...result, body: '' });
        if (signal?.aborted) {
          throw new LLMError('the model stream was aborted before it finished');
        }
        if (!sawChoice) {
          throw new LLMError('the model stream closed without sending any choices');
        }
      } catch (err) {
        failure = err;
      }
      done = true;
      nudge();
    },
    (err: unknown) => {
      failure = err instanceof LLMError ? err : new LLMError(messageOf(err), { cause: err });
      done = true;
      nudge();
    },
  );

  try {
    for (;;) {
      while (queue.length > 0) yield queue.shift() as ChatChunk;
      if (failure) throw failure;
      if (done) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    void call.catch(() => {});
  }
}

function assertOk(result: HostFetchResult): void {
  if (result.status >= 200 && result.status < 300) return;
  const detail = result.body ? `: ${result.body.slice(0, 500)}` : '';
  throw new LLMError(`model API answered ${result.status}${detail}`);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new LLMError('the model API answered something that is not JSON', {
      cause: err,
    });
  }
}

// ---------------------------------------------------------------------------
// Sessions: core's turn semantics over the host's blob store. One JSON blob
// per session id holding `{ record, checkpoint }`.

interface SessionBlob {
  record: SessionRecord;
  checkpoint: Checkpoint | null;
}

class BlobSessionStore implements SessionStore {
  async create(id: string, init: { flow?: string } = {}): Promise<void> {
    if (this.load(id)) return;
    this.save(id, {
      record: {
        id,
        flow: init.flow,
        createdAt: new Date().toISOString(),
        version: 0,
        turns: [],
      },
      checkpoint: null,
    });
  }

  async read(id: string): Promise<SessionRecord | undefined> {
    return this.load(id)?.record;
  }

  async append(id: string, turn: Turn, expect: number): Promise<number> {
    const blob = this.load(id) ?? {
      record: {
        id,
        flow: turn.flow,
        createdAt: new Date().toISOString(),
        version: 0,
        turns: [],
      },
      checkpoint: null,
    };

    if (blob.record.version !== expect) {
      throw new SessionConflictError(id, expect, blob.record.version);
    }

    blob.record.turns.push(turn);
    blob.record.version += 1;
    this.save(id, blob);
    return blob.record.version;
  }

  async readCheckpoint(id: string): Promise<Checkpoint | undefined> {
    return this.load(id)?.checkpoint ?? undefined;
  }

  async writeCheckpoint(id: string, checkpoint: Checkpoint | null): Promise<void> {
    const blob = this.load(id);
    if (!blob) return;
    blob.checkpoint = checkpoint;
    this.save(id, blob);
  }

  async list(_options: ListOptions = {}): Promise<SessionSummary[]> {
    // The host owns the directory of sessions; the engine only ever opens the
    // one it was handed. Listing is the host UI's job, done natively.
    return [];
  }

  async delete(id: string): Promise<void> {
    host.__host_sessionWrite(id, '');
  }

  private load(id: string): SessionBlob | undefined {
    const raw = host.__host_sessionRead(id);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as SessionBlob;
    } catch {
      return undefined;
    }
  }

  private save(id: string, blob: SessionBlob): void {
    host.__host_sessionWrite(id, JSON.stringify(blob));
  }
}

// ---------------------------------------------------------------------------
// A scratch "workspace" over the host file bridge, for the plugin node that
// asks where its files may go. Absolute under the run's declared scratch
// root, because the host's file bridge refuses anything else — a path here
// is meaningful to `__host_*`, not to any process; there are none.

let nextScratch = 0;

function scratchWorkspaceUnder(scratchDir: string) {
  return (label: string): Workspace => {
    const safe = label.replace(/[^A-Za-z0-9_-]+/g, '-');
    const root = `${scratchDir.replace(/\/+$/, '')}/${safe}-${nextScratch++}`;
    return {
      root,
      bin: `${root}/bin`,
      grants: () => [],
      toolPaths: () => [],
      dispose: () => {},
    } as unknown as Workspace;
  };
}

// ---------------------------------------------------------------------------
// The engine itself.

interface RunConfig {
  runId: string;
  flow: { text: string; format: 'yaml' | 'json' };
  bundleDir: string;
  scratchDir: string;
  plugins: Array<{
    manifest: Record<string, unknown>;
    entrySource: string;
    dir: string;
  }>;
  pluginConfig: Record<string, Record<string, unknown>>;
  inputs: Record<string, unknown>;
  session: string | null;
  resume: boolean;
  answer?: Record<string, unknown>;
  maxToolRounds?: number | string;
}

const UNLIMITED_ROUNDS = new Set(['unlimited', 'none', 'infinite', 'inf']);

const active = new Map<string, AbortController>();

function emit(runId: string, event: string, data: unknown): void {
  host.__host_emit(runId, JSON.stringify({ event, data }));
}

function parseFlowText(text: string, format: 'yaml' | 'json', plugins?: PluginRegistry): ParsedFlow {
  if (format === 'json') {
    return parseFlowObject(JSON.parse(text), plugins);
  }
  return parseFlowYaml(text, plugins);
}

function inspect(flowText: string, format: 'yaml' | 'json'): string {
  try {
    const flow = parseFlowText(flowText, format);
    const start = flow.parsedNodes.find(
      (node): node is StartNode => node.componentType === 'StartNode',
    );
    // A start node's *outputs* are the flow's inputs: they are what it hands
    // the first edge, and what a caller's `inputs` object is read into.
    const inputs = (start?.outputs ?? []).map((property) => ({
      key: propertyTitle(property),
      type: (property as { type?: string }).type ?? 'string',
      title: propertyTitle(property),
      required: (property as { required?: boolean }).required,
    }));
    return JSON.stringify({ ok: true, name: flow.name, inputs });
  } catch (err) {
    return JSON.stringify({ ok: false, error: messageOf(err) });
  }
}

function buildRegistry(config: RunConfig): PluginRegistry {
  const registry = PluginRegistry.empty();

  for (const entry of config.plugins) {
    const manifest = validateManifest(entry.manifest);
    const plugin = servePlugin(manifest, (serve: unknown) => {
      evaluateEntry(manifest.name, entry, serve);
    });
    registry.add(plugin);
  }

  return registry;
}

/**
 * Run a plugin's entry with the in-process `serve` injected.
 *
 * An import-free entry gets classic evaluation — exactly what
 * `node --import runtime` gives the same file. One that imports sibling
 * modules goes through the linker, its files read over the host bridge from
 * the plugin's directory (registered as a run root along with the rest of
 * the bundle). `checkPortability` ran this same linker before the bundle was
 * allowed here, so a refusal below means the extracted files changed since.
 */
function evaluateEntry(
  name: string,
  entry: RunConfig['plugins'][number],
  serve: unknown,
): void {
  if (!usesModuleSyntax(entry.entrySource)) {
    new Function('serve', entry.entrySource)(serve);
    return;
  }

  const root = entry.dir.replace(/\/+$/, '');
  const linked = linkEntry({
    source: entry.entrySource,
    read: (path) => host.__host_readFile(`${root}/${path}`),
  });
  if (!linked.ok) {
    throw new PluginError(
      `plugin "${name}" cannot run in-process: ${linked.problems.join('; ')}`,
    );
  }
  evaluateLinked(linked.modules, { serve });
}

async function execute(config: RunConfig): Promise<void> {
  const controller = new AbortController();
  active.set(config.runId, controller);
  const runId = config.runId;

  try {
    const plugins = buildRegistry(config);
    const flow = parseFlowText(config.flow.text, config.flow.format, plugins);

    const runnerOpts: RunnerOptions = {
      ...DEFAULT_RUNNER_OPTIONS,
      verbose: false,
      eventHandler: (event: Event) =>
        emit(runId, event.type, serializeEvent(event)),
    };
    applyMaxToolRounds(runnerOpts, config.maxToolRounds);

    const deps: Dependencies = {
      plugins,
      toolRegistry: plugins.toolRegistry(),
      eventHandler: runnerOpts.eventHandler,
      createProvider: portableCreateProvider,
      maxToolRounds: runnerOpts.maxToolRounds,
      scratchWorkspace: scratchWorkspaceUnder(config.scratchDir),
      stream: true,
    };
    runnerOpts.middleware = MiddlewareChain.build(
      plugins,
      deps,
      config.pluginConfig,
    );
    deps.middleware = runnerOpts.middleware;

    const graph = compile(flow, deps);
    validate(graph);

    if (config.session) {
      await runTurn(config, graph, runnerOpts, controller.signal);
    } else {
      const runner = new Runner(graph, runnerOpts);
      await runner.run(controller.signal, config.inputs);
    }
  } catch (err) {
    if (isSuspended(err)) {
      emit(runId, 'suspended', {
        session: config.session,
        ...err.suspension,
      });
    } else {
      emit(runId, 'error', { message: messageOf(err) });
    }
  } finally {
    active.delete(runId);
    host.__host_runEnded(runId);
  }
}

/**
 * One run, recorded in a conversation — the CLI's `runTurn`, minus the
 * terminal. The suspension does not close the turn, exactly as there: a
 * suspended conversation is mid-sentence, and the checkpoint holds the
 * question until `resume` brings the answer.
 */
async function runTurn(
  config: RunConfig,
  graph: ReturnType<typeof compile>,
  runnerOpts: RunnerOptions,
  signal: AbortSignal,
): Promise<void> {
  const store = new BlobSessionStore();
  const id = config.session as string;
  await store.create(id);

  const resumed = config.resume ? await resumeTurn(store, id) : undefined;
  const opened = resumed ?? (await openTurn(store, id, config.inputs));

  const from = resumed ? positionOf(resumed.checkpoint) : undefined;
  runnerOpts.checkpoints = checkpointSink({
    store,
    sessionId: id,
    runId: opened.runId,
    input: opened.input,
  });
  runnerOpts.durable = true;

  const started = resumed
    ? resumedTurnInputs(resumed, config.answer)
    : opened.inputs;

  let outcome: TurnOutcome;
  let failure: unknown;
  try {
    const runner = new Runner(graph, runnerOpts);
    const state = await runner.run(signal, started, from);
    outcome = { output: withoutReserved(state.toData()) };
  } catch (err) {
    failure = err;
    const error = err instanceof Error ? err : new Error(String(err));
    outcome = { error: { name: error.name, message: error.message } };
  }

  if (isSuspended(failure)) throw failure;

  await closeTurn(store, id, opened, outcome);
  if (failure) throw failure;
}

function resumedTurnInputs(
  resumed: NonNullable<Awaited<ReturnType<typeof resumeTurn>>>,
  answer: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const { suspension } = resumed.checkpoint;
  if (!suspension) return resumed.inputs;

  if (answer === undefined) {
    throw new Error(
      `this run stopped for a human: "${suspension.by}" is waiting on an ` +
        `answer to ${JSON.stringify(suspension.ask)}.`,
    );
  }
  return { ...resumed.inputs, ...resumeInputs(suspension, answer) };
}

function applyMaxToolRounds(
  opts: RunnerOptions,
  requested: number | string | undefined,
): void {
  if (requested === undefined) return;

  if (typeof requested === 'string') {
    if (UNLIMITED_ROUNDS.has(requested.trim().toLowerCase())) {
      opts.maxToolRounds = Infinity;
      return;
    }
    requested = Number(requested);
  }
  if (Number.isInteger(requested) && requested >= 1) {
    opts.maxToolRounds = requested;
  }
}

// ---------------------------------------------------------------------------
// The global the host talks to.

(globalThis as Record<string, unknown>).HeddleEngine = {
  version:
    typeof __HEDDLE_CORE_VERSION__ === 'string'
      ? __HEDDLE_CORE_VERSION__
      : 'dev',
  protocolVersion: EVENT_CONTRACT_VERSION,

  inspect,

  /**
   * Judge whether a plugin entry would evaluate here — the linker half of
   * `checkPortability`, offered to hosts whose portability check runs in
   * another language. Runs nothing. `pluginJSON` decodes to
   * `{entrySource, files: {path: source}}`; the answer is a JSON string,
   * `{ok: true}` or `{ok: false, problems: [...]}`.
   */
  linkCheck(pluginJSON: string): string {
    let plugin: { entrySource: string; files: Record<string, string> };
    try {
      plugin = JSON.parse(pluginJSON) as typeof plugin;
    } catch (err) {
      throw new Error(`linkCheck input is not JSON: ${messageOf(err)}`);
    }
    if (typeof plugin.entrySource !== 'string') {
      throw new Error('linkCheck input has no entrySource');
    }

    // The same gate `checkPortability` applies: an import-free entry never
    // meets the linker, so the linker has no opinion on it.
    if (!usesModuleSyntax(plugin.entrySource)) {
      return JSON.stringify({ ok: true });
    }
    const files = plugin.files ?? {};
    const linked = linkEntry({
      source: plugin.entrySource,
      read: (path) => (typeof files[path] === 'string' ? files[path] : null),
    });
    return JSON.stringify(
      linked.ok ? { ok: true } : { ok: false, problems: linked.problems },
    );
  },

  run(configJSON: string): void {
    let config: RunConfig;
    try {
      config = JSON.parse(configJSON) as RunConfig;
    } catch (err) {
      throw new Error(`run config is not JSON: ${messageOf(err)}`);
    }
    void execute(config);
  },

  cancel(runId: string): void {
    active.get(runId)?.abort(abortError('cancelled by the host'));
  },
};
