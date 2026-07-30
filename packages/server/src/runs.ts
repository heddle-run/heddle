import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  compile,
  validate,
  collectToolNames,
  EncoderStream,
  FileRegistry,
  PluginRegistry,
  SubprocessExecutor,
  Runner,
  type CompiledGraph,
  DEFAULT_RUNNER_OPTIONS,
  type Dependencies,
  type Event,
  type ParsedFlow,
  type Registry,
  type RunnerOptions,
} from '@heddle/core';
import type { ServerConfig } from './config.js';
import { HttpError, toErrorResponse } from './errors.js';
import { resolveFlow, type FlowRequest } from './flow-source.js';
import { readJsonBody, sendJson } from './http.js';
import type { ConcurrencyGate } from './limits.js';
import { buildPlugins } from './plugins.js';
import {
  materializeRequestCode,
  rejectRequestCode,
  NO_CODE,
  type MaterializedCode,
  type RequestCode,
} from './request-code.js';
import { resolveEncoder, requireStreamFor } from './encoders.js';
import { SseStream } from './sse.js';
import { assertToolsAvailable, mergeRegistries } from './tools.js';

interface RunRequest extends FlowRequest, RequestCode {
  inputs?: Record<string, unknown>;
}

/**
 * Reject request fields that name server-side configuration.
 *
 * Silently ignoring these would be worse than refusing them: a caller that
 * believes it selected a tools directory, and is not told otherwise, has been
 * misled about what the server will execute.
 */
function rejectServerSideFields(body: Record<string, unknown>): void {
  for (const field of [
    'toolsDir',
    'tools_dir',
    'flowsRoot',
    'flows_root',
    // Middleware and its configuration are the operator's, for the reason
    // `refuseMiddleware` gives. A caller who believes they set a retry policy
    // has been misled about what the server will do with their run.
    'middleware',
    'pluginConfig',
    'plugin_config',
    'maxNodeAttempts',
    'max_node_attempts',
  ]) {
    if (field in body) {
      throw new HttpError(
        400,
        `"${field}" is server-side configuration and cannot be set per request`,
      );
    }
  }
}

/**
 * The tools this run can reach: the server's, plus any the request submitted —
 * as scripts, and now as a plugin's manifest.
 *
 * Plugin tools go *first*, weakest, and that is deliberate. Later wins here, so
 * putting them first means a name the operator provides and a name the caller
 * typed into their own `tools` both beat a name a manifest bound in bulk.
 * `buildPlugins` already refuses a plugin tool that collides at all unless the
 * manifest asked to shadow, which submitted plugins may not do — so this
 * ordering is the second lock rather than the first.
 */
function buildRegistry(
  config: ServerConfig,
  code: MaterializedCode,
  plugins: PluginRegistry,
): Registry {
  const registries: Registry[] = [
    plugins.toolRegistry(),
    FileRegistry.create(config.toolsDir ?? ''),
  ];
  if (code.toolsDir) registries.push(FileRegistry.create(code.toolsDir));
  return mergeRegistries(...registries);
}

function buildDependencies(
  pf: ParsedFlow,
  config: ServerConfig,
  code: MaterializedCode,
  plugins: PluginRegistry,
  eventHandler: (e: Event) => void,
): Dependencies {
  const registry = buildRegistry(config, code, plugins);

  const toolNames = collectToolNames(pf);
  if (toolNames.length > 0) assertToolsAvailable(registry, toolNames);

  return {
    // Confinement is fixed at startup: a request can neither ask for a sandbox
    // nor opt out of one.
    toolExecutor: new SubprocessExecutor({ sandbox: config.sandbox }),
    toolRegistry: registry,
    plugins,
    eventHandler,
    // A server accepting submitted code is accepting submitted specs, and a
    // spec that resolves `$VAR` reads this process's environment — any
    // variable, not only a model key — and can send it wherever its own
    // llm_config points. Credentials belong in the spec, from the caller.
    allowEnvRefs: !config.allowRequestCode,
    defaultLlmKey: config.defaultLlmKey,
    defaultLlmUrl: config.defaultLlmUrl,
    stream: config.stream,
  };
}

function runnerOptions(
  config: ServerConfig,
  eventHandler: (e: Event) => void,
): RunnerOptions {
  return {
    maxIterations: config.maxIterations,
    timeout: config.timeout,
    verbose: false,
    eventHandler,
    // The default, and inert: this server installs no middleware, so nothing
    // ever asks to retry a node. It is set rather than omitted because the
    // field is required, and taking it from `DEFAULT_RUNNER_OPTIONS` here would
    // read as a knob an operator can turn, which on this path they cannot.
    maxNodeAttempts: DEFAULT_RUNNER_OPTIONS.maxNodeAttempts,
  };
}

/**
 * Everything that can fail on the caller's behalf: loading their plugins,
 * parsing their flow, resolving their tools, compiling and validating.
 *
 * Kept together and ahead of execution because the streaming path has to run
 * all of it before SSE headers go out — once the status is 200 it can no longer
 * report a bad request as one.
 */
async function prepare(
  body: RunRequest,
  config: ServerConfig,
  code: MaterializedCode,
  plugins: PluginRegistry,
  eventHandler: (e: Event) => void,
): Promise<CompiledGraph> {
  const pf = resolveFlow(body, config, plugins);
  const deps = buildDependencies(pf, config, code, plugins, eventHandler);
  const graph = compile(pf, deps);
  validate(graph);
  return graph;
}

/** POST /v1/runs — execute a flow and return the final state. */
export async function handleRun(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
  gate: ConcurrencyGate,
  stream: boolean,
  protocol: string | null,
  headers: Record<string, string> = {},
): Promise<void> {
  const body = await readJsonBody(req, config.maxBodyBytes);
  rejectServerSideFields(body);
  if (!config.allowRequestCode) rejectRequestCode(body);
  // Before the gate is taken and before any of the caller's code is written to
  // disk: a request whose two query parameters contradict each other is wrong
  // whatever its body says.
  requireStreamFor(protocol, stream);

  const runBody = body as RunRequest;
  const inputs = runBody.inputs ?? {};
  if (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs)) {
    throw new HttpError(400, '"inputs" must be a JSON object');
  }

  // Taken before any work: a caller that cannot have a slot should learn so
  // without the server first writing their code to disk.
  const release = gate.acquire();

  // Wire cancellation to the client: if the caller hangs up, stop the run
  // rather than leaving tool subprocesses and LLM calls in flight.
  const ac = new AbortController();
  let finished = false;
  res.on('close', () => {
    if (!finished) ac.abort();
  });

  let code: MaterializedCode = NO_CODE;
  let plugins = PluginRegistry.empty();
  try {
    if (config.allowRequestCode) {
      code = materializeRequestCode(runBody, config);
      plugins = buildPlugins(config, code);
    }

    if (stream) {
      await runStreaming(res, config, runBody, inputs, code, plugins, ac, protocol, headers);
    } else {
      await runBuffered(res, config, runBody, inputs, code, plugins, ac, headers);
    }
  } finally {
    finished = true;
    // Both halves of the caller's code stop here: the plugin processes are
    // killed, and the directory their source came from is removed. Nothing the
    // caller sent survives their request, which is what lets this process
    // serve the next one.
    plugins.dispose();
    code.dispose();
    release();
  }
}

async function runBuffered(
  res: ServerResponse,
  config: ServerConfig,
  runBody: RunRequest,
  inputs: Record<string, unknown>,
  code: MaterializedCode,
  plugins: PluginRegistry,
  ac: AbortController,
  headers: Record<string, string>,
): Promise<void> {
  const graph = await prepare(runBody, config, code, plugins, () => {});
  const runner = new Runner(graph, runnerOptions(config, () => {}));
  const state = await runner.run(ac.signal, inputs);

  sendJson(res, 200, { flow: graph.name, state: state.toData() }, headers);
}

async function runStreaming(
  res: ServerResponse,
  config: ServerConfig,
  runBody: RunRequest,
  inputs: Record<string, unknown>,
  code: MaterializedCode,
  plugins: PluginRegistry,
  ac: AbortController,
  protocol: string | null,
  headers: Record<string, string>,
): Promise<void> {
  const sse = new SseStream(res, headers);
  // Resolved before compiling, because an unknown protocol is a request error
  // like a bad flow is, and both have to be reported while a 4xx is still
  // possible. It needs the registry, so it cannot happen any earlier than this.
  const encoder = resolveEncoder(protocol, plugins);

  // Nothing writes to the stream until `sse.open()`, which is after the compile
  // — so the handler installed for `prepare` has nowhere to put an event, and
  // drops one. Nothing emits during compilation or validation today; if
  // something ever does, dropping it is still right, because at that point the
  // response is a JSON 4xx body rather than a stream.
  let events: EncoderStream | undefined;

  let graph: CompiledGraph;
  try {
    graph = await prepare(runBody, config, code, plugins, (e) => events?.offer(e));
  } catch (err) {
    const { status, body } = toErrorResponse(err);
    sendJson(res, status, body, headers);
    return;
  }

  // heddle's identity for this run. It exists for the encoder: a protocol with a
  // run identity needs one, and cannot invent a stable one per frame. Minted
  // here rather than in the engine because the request is the thing being
  // identified — the engine runs a graph and has never needed a name for one.
  const runId = randomUUID();

  events = new EncoderStream(
    encoder.create(runId),
    (frame) => sse.sendFrame(frame),
    // An encoder that throws stops the run. With one selected, its rendering
    // *is* the response, so a run whose answer nobody can read is not worth
    // spending the caller's money and this server's slot on — the same
    // reasoning as the `res.on('close')` abort when a caller hangs up. It is
    // also the only kind of encoder failure that is prompt: without this the
    // run would continue to completion, rendering nothing.
    () => ac.abort(),
  );

  sse.open(encoder.contentType);

  const runner = new Runner(graph, runnerOptions(config, events.handler()));

  let failure: unknown;
  try {
    await runner.run(ac.signal, inputs);
  } catch (err) {
    failure = err;
  }

  // Drained before anything else is written, on every path. Two things depend on
  // it: the events the engine queued are rendered before the stream ends, and
  // the encoder's own terminal frames — AG-UI's `RUN_FINISHED`, which a client
  // waits for even on an aborted run — go out ahead of heddle's error channel
  // rather than after it.
  try {
    await events.close();
  } catch (err) {
    // The encoder's failure supersedes the run's, and deliberately: when the
    // encoder is what broke, the run's own error is `operation was aborted` —
    // true, caused by the abort above, and useless to whoever has to fix the
    // encoder.
    failure = err;
  }

  if (failure) {
    // Headers are already sent, so failures travel as an `error` frame. This is
    // the transport's error channel, not a second event model: engine failures
    // that have a runner event (node_error) have already been sent, and this
    // frame is heddle's own rather than the selected protocol's — a client
    // reading `ag-ui` gets one named frame it did not ask for, which is better
    // than a stream that stops with no reason given.
    const { body } = toErrorResponse(failure);
    sse.send('error', body.error);
  }
  sse.close();
}
