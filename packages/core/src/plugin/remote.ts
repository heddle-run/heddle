/**
 * Presents an out-of-process plugin through the same interfaces an in-process
 * one implements.
 *
 * This is what keeps the redesign contained. `compile()` asks the registry for
 * a `PluginNodeDef` and builds a `PluginNodeAdapter` around it; neither has to
 * learn that a plugin might live in another process. The difference is only in
 * where each hook's answer comes from:
 *
 *   validate, inferInputs, inferOutputs, branches   →  the manifest (data)
 *   execute, apply, after                           →  an RPC call
 *
 * The synchronous hooks stay synchronous because the manifest already holds
 * their answers, which is the reason the manifest exists.
 */
import type { ManifestComponent, ManifestTool, PluginManifest } from './manifest.js';
import type { ToolDef } from '../tool/types.js';
import type { PluginHost } from './host.js';
import { toolRunner } from './services.js';
import { checkSchema } from './schema.js';
import { PluginError } from '../errors.js';
import type { Dependencies } from '../node/types.js';
import type {
  PluginComponent,
  PluginComponentDef,
  PluginEncoder,
  PluginEncoderDef,
  PluginMiddlewareDef,
  PluginMiddlewareExecutor,
  PluginNode,
  PluginNodeDef,
  PluginNodeExecutor,
  PluginProviderDef,
  PluginResult,
  PluginTransformDef,
  PluginTransformExecutor,
  TransformPhase,
  TransformResult,
  WireFrame,
} from './types.js';
import {
  readAfterVerdict,
  readChatChunk,
  readChatResponse,
  readToolResult,
  readWireFrames,
  type AfterVerdict,
} from './protocol.js';
import { serializeEvent } from './encoder.js';
import type { Event } from '../runner/events.js';
import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  Message,
  Provider,
} from '../llm/types.js';

/**
 * Strip a component to what can cross a pipe.
 *
 * Spec components carry agentspec `Property` instances and may hold cycles
 * through referenced components. A round trip through JSON is the cheap way to
 * guarantee the plugin receives something it can parse, and to guarantee heddle
 * notices here — rather than as a truncated write — when it cannot.
 */
function serializable(value: unknown, what: string): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch (err) {
    throw new PluginError(`${what} cannot be serialized for an out-of-process plugin`, {
      cause: err,
    });
  }
}

function checkComponent(entry: ManifestComponent, component: PluginComponent): void {
  if (!entry.schema) return;
  checkSchema(component, entry.schema, `${entry.componentType} "${component.name}"`);
}

/** The node half: a custom node type executed in the plugin's process. */
export function remoteNodeDef(
  manifest: PluginManifest,
  entry: ManifestComponent,
  host: () => PluginHost,
): PluginNodeDef {
  const def: PluginNodeDef = {
    componentType: entry.componentType,

    createExecutor(node: PluginNode, deps): PluginNodeExecutor {
      const wire = serializable(node, `${entry.componentType} "${node.name}"`);
      // The compiled graph's dependencies are the first place a tool registry
      // exists, so this is where the plugin's `runTool` gets something to call.
      host().setToolRunner(
        toolRunner(nameOf(manifest.name, entry.componentType, node.name), deps),
      );

      return {
        async execute(input, ctx): Promise<PluginResult> {
          // The run's signal goes with the call. An in-process plugin is free
          // to ignore `ctx.signal` and the run still ends when its own stack
          // unwinds; a remote one is a process heddle is blocked on, so an
          // abort that does not reach the host holds the run's concurrency
          // slot until the plugin's per-call timer fires instead.
          const raw = await host().call(
            'execute',
            {
              componentType: entry.componentType,
              node: wire,
              input,
              // Read here rather than served as a reverse call, for the
              // reasons on `ExecuteParams.workspace` — and withheld when the
              // plugin's own process is confined, because the node's scope is
              // a different sandbox session and its path is one the plugin
              // cannot open. Sending it anyway would be the one thing that
              // field must not do. The cost of sending it is visible at this
              // line: without a sandbox `getWorkspace` creates the directory
              // whether or not the plugin ever opens it, so a confined plugin
              // is also spared a mkdtemp for a path it could not use.
              ...(host().confined
                ? { workspaceUnavailable: 'confined' as const }
                : { workspace: ctx.getWorkspace() }),
            },
            {
              signal: ctx.signal,
              // The context heddle built for this node, handed over piece by
              // piece. What a remote plugin's `emitEvent`, `runTool` and
              // `callModel` reach are therefore the very functions an
              // in-process one calls directly — the namespace, the attribution,
              // the tool scope and the model config all come from one place,
              // and the two paths cannot drift into doing different things.
              reporter: ctx,
              // Bound to the tool scope heddle opened for this execution, so a
              // tool the plugin runs sees the workspace the plugin was told
              // about — and gets the run's signal, which the host-wide runner
              // drops.
              runTool: ctx.runTool,
              callModel: ctx.callModel,
            },
          );
          return asResult(manifest.name, entry.componentType, node.name, raw);
        },
      };
    },
  };

  // Assigned only when the manifest declares them, so a component that says
  // nothing about its inputs leaves them undefined rather than empty — the
  // deserializer treats those differently.
  if (entry.schema) {
    def.validate = (component) => checkComponent(entry, component);
  }
  if (entry.inputs) def.inferInputs = () => entry.inputs!;
  if (entry.outputs) def.inferOutputs = () => entry.outputs!;
  if (entry.branches) def.branches = () => entry.branches!;

  return def;
}

/** The transform half: a message transform executed in the plugin's process. */
export function remoteTransformDef(
  manifest: PluginManifest,
  entry: ManifestComponent,
  host: () => PluginHost,
): PluginTransformDef {
  const def: PluginTransformDef = {
    componentType: entry.componentType,

    phase: () => entry.phase ?? 'pre',

    createTransform(component: PluginComponent, deps): PluginTransformExecutor {
      const wire = serializable(component, `${entry.componentType} "${component.name}"`);
      // Same wiring as a node's, and for the same reason: what a plugin may do
      // has to follow from the plugin, not from where in the spec it was
      // written. A guardrail that consults a classifier tool is the ordinary
      // case, and without this it reached a host with no runner and was told it
      // had no tool access.
      host().setToolRunner(
        toolRunner(nameOf(manifest.name, entry.componentType, component.name), deps),
      );

      return {
        async apply(messages: Message[], ctx): Promise<TransformResult> {
          // Carried for the same reason a node's is: a transform runs inside an
          // agent turn, which is the longest a run can be blocked on one call.
          const raw = await host().call(
            'apply',
            {
              componentType: entry.componentType,
              component: wire,
              phase: ctx.phase,
              messages,
            },
            {
              signal: ctx.signal,
              // As a node's, and carrying the same attribution decision: a
              // transform's events name the agent it hangs off, because the
              // chain built this context knowing which agent that is and a
              // transform holds no position in the graph of its own.
              reporter: ctx,
              // A transform's own, which is scopeless — the same throwaway
              // session per call it gets in process. Passed rather than left to
              // the host's fallback so that what a transform may do stops
              // depending on whether an unrelated node compiled first.
              runTool: ctx.runTool,
              callModel: ctx.callModel,
            },
          );
          return asTransformResult(manifest.name, entry.componentType, raw);
        },
      };
    },
  };

  if (entry.schema) {
    def.validate = (component) => checkComponent(entry, component);
  }

  return def;
}

/**
 * The middleware half: a seam hook executed in the plugin's process.
 *
 * The one kind with no spec component behind it. `createMiddleware` therefore
 * takes the operator's configuration where the others take a document's
 * component, and `validate` becomes `validateConfig` — the manifest's `schema`
 * describes that configuration, because there is no document for it to
 * describe. The check runs where the configuration arrives, in
 * `MiddlewareChain.build`, and not here: this function is handed a manifest,
 * and the operator's answer to it turns up later.
 */
export function remoteMiddlewareDef(
  manifest: PluginManifest,
  entry: ManifestComponent,
  host: () => PluginHost,
): PluginMiddlewareDef {
  return {
    componentType: entry.componentType,
    seams: entry.seams ?? {},

    validateConfig(config): void {
      if (!entry.schema) return;
      checkSchema(
        config,
        entry.schema,
        `plugin "${manifest.name}": configuration for "${entry.componentType}"`,
      );
    },

    createMiddleware(config, deps): PluginMiddlewareExecutor {
      const wire = serializable(config, `${entry.componentType} configuration`);
      // The same wiring a transform gets, and for the same reason: what a
      // component may do has to follow from the component, not from which other
      // component of the same plugin happened to compile first. Without this a
      // middleware's `runTool` would work only when the plugin also shipped a
      // node that had already run — `setToolRunner` is first-writer-wins.
      host().setToolRunner(
        toolRunner(`plugin "${manifest.name}": middleware "${entry.componentType}"`, deps),
      );

      return {
        async after({ subject, outcome }, ctx): Promise<AfterVerdict> {
          const raw = await host().call(
            'after',
            {
              seam: ctx.seam,
              componentType: entry.componentType,
              component: wire,
              subject,
              outcome,
              attempt: ctx.attempt,
              maxAttempts: ctx.maxAttempts,
            },
            {
              signal: ctx.signal,
              // Handed over whole, exactly as a node's is, so a remote
              // middleware's events, logs, tools and model calls are the ones
              // heddle built for this consult rather than a second set that has
              // to be kept identical to them.
              reporter: ctx,
              runTool: ctx.runTool,
              callModel: ctx.callModel,
            },
          );
          return readAfterVerdict(
            ctx.seam,
            raw,
            `middleware "${entry.componentType}" (plugin "${manifest.name}")`,
          );
        },
      };
    },
  };
}

/**
 * The provider half: a custom `llm_config` type served from the plugin's
 * process.
 *
 * The one kind whose remote form has to bridge two *shapes* of stream rather
 * than just two processes, and the bridge is {@link pullFrom} below. A
 * `Provider` streams by pull — an `AsyncIterable` the consumer drives, which
 * ends by returning and fails by throwing. A plugin streams by push — frames
 * arriving whenever they arrive, delivered to a callback with no way to say
 * "slower". Three rules make the second presentable as the first, and all three
 * are the protocol's rather than this function's:
 *
 * 1. Each partial's payload is one {@link ChatChunk}.
 * 2. The call's response is the last chunk and the end of the stream — so a call
 *    that ends without one is a failed call, not an empty answer.
 * 3. A partial restarts the call's silence budget (`PluginHost.call`), which
 *    means a provider that buffers internally and emits nothing for longer than
 *    the budget is killed exactly like one that hung. Streaming providers have
 *    to actually stream.
 *
 * There is no back-pressure and there cannot be: the plugin writes to a pipe
 * heddle drains, so a consumer that falls behind grows the queue rather than
 * slowing the producer. In practice the consumer is `collectStream`, which does
 * nothing per chunk but append and emit an event.
 *
 * `chatCompletionStream` is present only when the manifest declared `stream`.
 * That is what makes the decision static: `completeChat` checks for the method
 * and falls back to the buffered call when it is absent, so a provider that
 * cannot stream is never asked to and never has to answer a `stream: true`
 * frame it has no handler for.
 *
 * **The per-call budget bites hardest on this verb, and rule 3 is why.** Every
 * other host call is work the plugin does locally; this one is a plugin waiting
 * on somebody else's model, and a long generation routinely outlasts
 * `DEFAULT_CALL_TIMEOUT`. There is no `serving()` hold to take — that mechanism
 * is for a plugin blocked on *heddle*, and here heddle is the one waiting — so a
 * buffered provider genuinely has to answer within whatever
 * `--plugin-call-timeout` allows. A streaming one does not, because each partial
 * restarts the clock. That is the practical argument for declaring `stream`,
 * over and above what a client sees.
 */
export function remoteProviderDef(
  manifest: PluginManifest,
  entry: ManifestComponent,
  host: () => PluginHost,
): PluginProviderDef {
  const def: PluginProviderDef = {
    componentType: entry.componentType,

    createProvider(component: PluginComponent, deps): Provider {
      const where = nameOf(manifest.name, entry.componentType, component.name);
      // Once per compiled graph, not once per call: this is the same component
      // for every request that reaches it, and JSON round-tripping a config on
      // every model call would be a cost paid per token-producing request.
      const config = serializable(
        component,
        `${entry.componentType} "${component.name}"`,
      );

      // A transform's, and for a transform's reason twice over. A provider owns
      // no tool scope — it is not a node, it opened nothing — so a throwaway
      // sandbox session per call is the honest answer. And it is passed
      // explicitly rather than left to `PluginHost`'s host-wide fallback,
      // because that fallback is whatever `setToolRunner` was first given: a
      // provider whose plugin also ships a node would otherwise run its tools
      // in *that node's* session and workspace, and the same provider loaded
      // without the node would get a throwaway one. What a component may do
      // must not depend on which sibling compiled first.
      //
      // `callModel` is deliberately absent, and so `PluginHost.serveCallModel`
      // refuses it. A provider *is* the model; the config it would call on is
      // itself, which is a loop heddle would have no way to bound.
      const runTool = toolRunner(where, deps);

      const provider: Provider = {
        async chatCompletion(signal, request: ChatRequest): Promise<ChatResponse> {
          const raw = await host().call(
            'chat',
            { componentType: entry.componentType, config, request, stream: false },
            { signal, runTool },
          );
          return readChatResponse(raw, where);
        },
      };

      if (entry.stream) {
        provider.chatCompletionStream = (signal, request): AsyncIterable<ChatChunk> =>
          pullFrom(
            (onPartial) =>
              host().call(
                'chat',
                { componentType: entry.componentType, config, request, stream: true },
                { signal, onPartial, runTool },
              ),
            where,
          );
      }

      return provider;
    },
  };

  if (entry.schema) {
    def.validate = (component) => checkComponent(entry, component);
  }

  return def;
}

/**
 * Turn a pushed sequence of frames into a stream a consumer drives.
 *
 * A queue and one waiter, which is all this needs: `PluginHost` delivers
 * partials from a single stdout handler, so there is exactly one producer, and
 * `for await` gives exactly one consumer. The waiter is woken on every event
 * that could unblock it — a chunk arrived, the call answered, the call failed —
 * so the loop never parks on a queue that will not fill. Setting `wake` cannot
 * race the producer: `new Promise`'s executor runs synchronously, and there is
 * no `await` between the checks above it and the assignment.
 *
 * An `async function*`, so calling it returns a *generator* rather than a
 * re-iterable object — which is what `OpenAIProvider.chatCompletionStream` is,
 * and the difference is not cosmetic. A plain iterable would start a fresh
 * `chat` call every time something iterated it, so a consumer that looped twice
 * would quietly make two model calls and be billed for both.
 *
 * The queue is drained before the failure check on each turn, deliberately: a
 * stream that produced ten chunks and then died delivers all ten, and the
 * consumer's own `try` decides what a partial answer is worth. Throwing early
 * would discard chunks heddle had already accepted, and `completeChat` is the
 * place that knows a half-answer must not become a node's output.
 */
async function* pullFrom(
  start: (onPartial: (partial: unknown) => void) => Promise<unknown>,
  where: string,
): AsyncGenerator<ChatChunk> {
  const queue: ChatChunk[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  // A flag rather than `failure !== undefined`, because rule 2 turns on telling
  // "the call failed" from "the call ended". A rejection carrying a falsy value
  // read as no failure would end the iteration cleanly, and `collectStream`
  // would hand the node an empty answer — the exact outcome the rule exists to
  // make impossible.
  let failed = false;
  let failure: unknown;

  const nudge = (): void => {
    wake?.();
    wake = undefined;
  };

  // A chunk that does not parse ends the call rather than the process:
  // `PluginHost.progress` catches a throw from `onPartial` and abandons the
  // call with it, so the rejection below carries this very error.
  const call = start((partial) => {
    queue.push(readChatChunk(partial, where));
    nudge();
  }).then(
    (result) => {
      try {
        // Rule 2: the response is the final chunk — typically the one carrying
        // `finish_reason`. A provider that said everything in its partials
        // answers with `{}`, or with nothing at all, and neither is an error:
        // what makes a stream complete is that the response *arrived*, not what
        // was in it.
        if (result !== undefined && result !== null) {
          queue.push(readChatChunk(result, where));
        }
      } catch (err) {
        // A malformed final frame is a failed call, not a stream that ended.
        // Unlike a partial's, this throw is on a `.then` callback with nothing
        // above it to catch — uncaught, it would be an unhandled rejection and
        // the iterator would simply finish.
        failed = true;
        failure = err;
      }
      done = true;
      nudge();
    },
    (err: unknown) => {
      failed = true;
      failure = err;
      done = true;
      nudge();
    },
  );

  try {
    for (;;) {
      while (queue.length > 0) yield queue.shift()!;
      if (failed) throw failure;
      if (done) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    // A consumer that breaks out early — `completeChat` throwing mid-stream —
    // leaves this promise unobserved, and an unobserved rejection here is an
    // unhandled rejection on the host's stack. The call itself is already
    // cancelled by the signal the caller passed.
    void call.catch(() => {});
  }
}

/**
 * The encoder half: a rendering of the run served from the plugin's process.
 *
 * The only kind whose remote form is *cheaper* to reason about than the local
 * one, because an encoder asks the host for nothing. There is no `runTool` to
 * thread and no session to open — `Event → WireFrame[]` needs no capability — so
 * what crosses the pipe is one event out and frames back, and the plugin has
 * nothing to be granted.
 *
 * Two things about the boundary are worth stating because both are decisions
 * rather than consequences:
 *
 * - **The event crosses as `serializeEvent` renders it**, which is the same
 *   object heddle's own protocol puts on the wire. A plugin encoder therefore
 *   reads exactly what a browser watching `?protocol=heddle` reads, rather than
 *   a shape invented for plugins that would have to be kept in step with it.
 * - **No `signal`.** Every other verb takes the run's signal so a cancelled run
 *   stops work in flight; here the work *is* the reporting of what already
 *   happened, and `finishEncode` in particular exists to be called on the
 *   aborted path. Passing a signal would cancel exactly the frames a client
 *   needs most — the terminal ones — leaving it waiting for an end that heddle
 *   deliberately declined to send. The bound is instead the per-call timeout,
 *   which an encoder that has stopped answering hits like any other plugin.
 */
export function remoteEncoderDef(
  manifest: PluginManifest,
  entry: ManifestComponent,
  host: () => PluginHost,
): PluginEncoderDef {
  // The protocol name rather than a spec name, because an encoder has none —
  // nothing writes one into a document. It is also the name the client asked
  // for, which is the useful half of "who is this" in a failure.
  const where = nameOf(manifest.name, entry.componentType, entry.protocol!);
  const componentType = entry.componentType;

  return {
    componentType,
    protocol: entry.protocol!,
    contentType: entry.contentType!,

    createEncoder(runId: string): PluginEncoder {
      return {
        async encode(event: Event): Promise<WireFrame[]> {
          const raw = await host().call('encode', {
            componentType,
            runId,
            event: serializeEvent(event),
          });
          return readWireFrames(raw, `${where} rendering a "${event.type}"`);
        },

        async finish(): Promise<WireFrame[]> {
          const raw = await host().call('finishEncode', { componentType, runId });
          return readWireFrames(raw, `${where} finishing the run`);
        },
      };
    },
  };
}

/** A component type that is neither node nor transform: validation only. */
export function remoteComponentDef(entry: ManifestComponent): PluginComponentDef {
  const def: PluginComponentDef = { componentType: entry.componentType };
  if (entry.schema) {
    def.validate = (component) => checkComponent(entry, component);
  }
  return def;
}

/**
 * Check what came back over the pipe.
 *
 * The in-process adapter already checks the shape of a plugin's return value,
 * but it can trust that the value is at least a JS object of the plugin's own
 * making. Here it is parsed JSON from another process, so the checks have to
 * happen before the value is handed on as a node's output.
 */
function asResult(
  plugin: string,
  componentType: string,
  nodeName: string,
  raw: unknown,
): PluginResult {
  const where = `plugin "${plugin}": ${componentType} "${nodeName}"`;

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PluginError(`${where} returned ${typeOf(raw)}, expected { output, branch? }`);
  }
  const result = raw as Record<string, unknown>;

  if (typeof result.output !== 'object' || result.output === null || Array.isArray(result.output)) {
    throw new PluginError(`${where} returned no "output" object`);
  }
  if (result.branch !== undefined && typeof result.branch !== 'string') {
    throw new PluginError(`${where} returned a non-string "branch"`);
  }

  return {
    output: result.output as Record<string, unknown>,
    branch: result.branch as string | undefined,
  };
}

const ACTIONS = new Set(['pass', 'modify', 'reject']);

function asTransformResult(
  plugin: string,
  componentType: string,
  raw: unknown,
): TransformResult {
  const where = `plugin "${plugin}": ${componentType}`;

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PluginError(`${where} returned ${typeOf(raw)}, expected { action, ... }`);
  }
  const result = raw as Record<string, unknown>;

  if (typeof result.action !== 'string' || !ACTIONS.has(result.action)) {
    throw new PluginError(
      `${where} returned action ${JSON.stringify(result.action)}; expected pass, modify or reject`,
    );
  }
  if (result.action === 'modify' && !Array.isArray(result.messages)) {
    throw new PluginError(`${where} returned action "modify" without "messages"`);
  }

  return {
    action: result.action as TransformResult['action'],
    messages: result.messages as Message[] | undefined,
    reason: typeof result.reason === 'string' ? result.reason : undefined,
  };
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}

/**
 * How a component is named in an error raised on its behalf.
 *
 * The plugin as well as the component, because out of process the plugin is the
 * unit an operator installed, killed or sandboxed — and two plugins are free to
 * provide the same `componentType`.
 */
function nameOf(plugin: string, componentType: string, componentName: string): string {
  return `plugin "${plugin}": ${componentType} "${componentName}"`;
}

/**
 * A tool the plugin itself implements, as a {@link ToolDef} the registry holds.
 *
 * The whole of what makes this work is that nothing downstream can tell it from
 * a file. `invokeTool` branches once, and after that the agent loop, `ToolNode`
 * and a plugin's own `runTool` all treat it as the tool it is.
 *
 * No `signal` is threaded from the caller into the host call, and that is not an
 * oversight: `PluginHost.call` refuses a call whose signal has already aborted
 * and cancels one whose signal fires, so passing the run's signal is exactly
 * right — it is passed. What is *not* passed is a timeout of this call's own,
 * because the plugin's per-call budget already bounds it and a second clock
 * would race the first to report the same thing less usefully.
 */
export function remoteToolDef(
  manifest: PluginManifest,
  tool: ManifestTool,
  host: () => PluginHost,
): ToolDef {
  const where = `plugin "${manifest.name}": tool "${tool.name}"`;

  return {
    name: tool.name,
    description: tool.description ?? '',
    origin: `plugin:${manifest.name}`,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    shadows: tool.shadows,
    impl: {
      kind: 'plugin',
      plugin: manifest.name,
      call: async (signal, input) => {
        const raw = await host().call(
          'callTool',
          {
            componentType: tool.componentType!,
            tool: tool.name,
            input,
          },
          { signal },
        );
        return readToolResult(raw, where);
      },
    },
  };
}

export type { TransformPhase };
