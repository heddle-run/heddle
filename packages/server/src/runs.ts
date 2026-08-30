import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  compile,
  validate,
  collectToolNames,
  checkpointSink,
  closeTurn,
  isSuspended,
  openTurn,
  positionOf,
  resumeInputs,
  resumeTurn,
  withoutReserved,
  workspaceTools,
  standardRegistry,
  EncoderStream,
  FileRegistry,
  MiddlewareChain,
  PluginRegistry,
  State,
  SubprocessExecutor,
  Runner,
  type CompiledGraph,
  type Dependencies,
  type Event,
  type OpenedBundle,
  type OpenedTurn,
  type ParsedFlow,
  type Registry,
  type RunnerOptions,
  type RunPosition,
  type RunSuspended,
  type SessionRecord,
  type SessionStore,
  type TurnOutcome,
  type WorkspaceFactory,
} from '@heddle-run/core';
import { materializeBundle, rejectBundleConflicts } from './bundles.js';
import type { ServerConfig } from './config.js';
import { HttpError, toErrorResponse } from './errors.js';
import {
  resolveBundleFlow,
  resolveFlow,
  type FlowRequest,
} from './flow-source.js';
import { readJsonBody, sendJson } from './http.js';
import type { ConcurrencyGate } from './limits.js';
import { buildPlugins, bundlePlugins } from './plugins.js';
import {
  asBadRequest,
  materializeRequestCode,
  rejectRequestCode,
  NO_CODE,
  type MaterializedCode,
  type RequestCode,
} from './request-code.js';
import { resolveEncoder, requireStreamFor } from './encoders.js';
import { resolveSession } from './sessions.js';
import { SseStream } from './sse.js';
import { assertToolsAvailable } from './tools.js';

interface RunRequest extends FlowRequest, RequestCode {
  inputs?: Record<string, unknown>;
  session?: string;
  durable?: boolean;
  resume?: boolean;
  /** What to tell a run that stopped on a human, with "resume". */
  answer?: Record<string, unknown>;
  /** A stored bundle's id, as `POST /v1/bundles` returned it. */
  bundle?: string;
  /** A one-shot `.heddle` archive, base64. Extracted for this run, then gone. */
  bundleData?: string;
}

/** The conversation a run belongs to, once its turn has been opened. */
interface SessionTurn {
  store: SessionStore;
  id: string;
  opened: OpenedTurn;
  /** Where to re-enter the graph, when this turn is continuing a run. */
  from?: RunPosition;
}

interface Prepared {
  graph: CompiledGraph;
  middleware: MiddlewareChain;
}

interface RunPlan {
  config: ServerConfig;
  body: RunRequest;
  inputs: Record<string, unknown>;
  code: MaterializedCode;
  plugins: PluginRegistry;
  /** The server's, plus whatever this request put in its own workspaces. */
  workspaces: WorkspaceFactory;
  abort: AbortController;
  headers: Record<string, string>;
  session?: SessionTurn;
  /** The bundle this run is, when the request named one. */
  bundle?: OpenedBundle;
}

const SERVER_SIDE_FIELDS = [
  'toolsDir',
  'tools_dir',
  'flowsRoot',
  'flows_root',
  'middleware',
  'pluginConfig',
  'plugin_config',
  'maxNodeAttempts',
  'max_node_attempts',
  'maxToolRounds',
  'max_tool_rounds',
];

const IGNORE_EVENTS = (): void => {};

export async function handleRun(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
  gate: ConcurrencyGate,
  stream: boolean,
  protocol: string | null,
  headers: Record<string, string> = {},
): Promise<void> {
  const body = await readJsonBody(req, runBodyLimit(config));
  rejectServerSideFields(body);
  rejectBundleConflicts(body, config);
  if (!config.allowRequestCode) rejectRequestCode(body);
  requireStreamFor(protocol, stream);

  const runBody = body as RunRequest;
  const release = gate.acquire();
  const abort = abortWhenClientHangsUp(res);

  let bundle: OpenedBundle | undefined;
  let code: MaterializedCode = NO_CODE;
  let plugins = PluginRegistry.empty();
  let workspaces = config.workspaces;

  try {
    bundle = materializeBundle(runBody, config);
    // Underneath the caller's own, so a bundle's recorded input is what the
    // run starts from and the body's is what the caller changed their mind
    // about. The bundle's `interactive` is deliberately not read: a wish for a
    // conversation means nothing on one HTTP request.
    const inputs = bundle
      ? { ...bundle.input, ...readInputs(runBody) }
      : readInputs(runBody);

    if (config.allowRequestCode) code = materializeRequestCode(runBody, config);
    // A bundle's plugins are loaded with full rights; a request's are refused
    // everything `buildPlugins` refuses. The two cannot meet — the field
    // collision was rejected above — and with neither, both branches resolve
    // to the operator's layer alone.
    plugins = bundle
      ? await bundlePlugins(config, bundle)
      : buildPlugins(config, code);
    // The same shape, for the same reason: the server's factory is built once
    // at startup and this layers the request's own files onto a copy of it. A
    // collision with something the operator mounted is refused here rather than
    // shadowing it, which is why it can be the caller's 400. With nothing to
    // layer, the operator's factory is used as it is — the dispose guard below
    // already knows not to touch it.
    const mounts = bundle?.mounts ?? code.mounts;
    if (mounts.length > 0) {
      workspaces = asBadRequest(() => config.workspaces.extend(mounts));
    }

    // Before anything is compiled, so a session that is busy or unknown is
    // refused without the request having spent a graph on it — and so the
    // history is in the inputs the graph is then given.
    const session = await openSession(config, runBody, inputs, bundle);

    const plan: RunPlan = {
      config,
      body: runBody,
      inputs: session?.opened.inputs ?? inputs,
      code,
      plugins,
      workspaces,
      abort: abort.controller,
      headers,
      session,
      bundle,
    };

    if (stream) await runStreaming(res, plan, protocol);
    else await runBuffered(res, plan);
  } finally {
    abort.finish();
    // The same guard the workspaces get: with no submitted plugins the run
    // borrowed the operator's registry, whose processes every other run is
    // still using.
    if (plugins !== config.plugins) plugins.dispose();
    // Removes the template assembled from this request's files and leaves the
    // operator's, which every other run is still using. The guard is for the
    // path where `extend` never ran: disposing the server's own factory here
    // would delete what every later run starts from.
    if (workspaces !== config.workspaces) workspaces.dispose();
    code.dispose();
    // A no-op for a stored bundle, whose directory is the store's; for inline
    // bytes this removes everything the request carried in.
    bundle?.dispose();
    release();
  }
}

/**
 * The body cap for this route, which is the one route a bundle rides through.
 *
 * With bundles on, room for `maxBodyBytes` of request plus the base64 cost of
 * one archive at the bundle limit — the inline form is a JSON field, and a cap
 * sized for JSON alone would refuse every archive the bundle limit allows.
 * `--no-bundles` puts it back exactly where it was.
 */
function runBodyLimit(config: ServerConfig): number {
  if (!config.bundles) return config.maxBodyBytes;
  return config.maxBodyBytes + Math.ceil((config.maxBundleBytes * 4) / 3);
}

async function openSession(
  config: ServerConfig,
  body: RunRequest,
  inputs: Record<string, unknown>,
  bundle?: OpenedBundle,
): Promise<SessionTurn | undefined> {
  if (body.session === undefined) {
    assertNoSessionOnlyFields(body);
    return undefined;
  }

  const { store, id, record } = await resolveSession(config, body.session);

  if (body.resume === true) {
    assertBundleRepeated(record, body);
    const resumed = await resumeTurn(store, id);
    const { suspension } = resumed.checkpoint;

    if (suspension) {
      const answer = readAnswer(body, suspension.ask);
      resumed.inputs = { ...resumed.inputs, ...resumeInputs(suspension, answer) };
    }

    return { store, id, opened: resumed, from: positionOf(resumed.checkpoint) };
  }

  const opened = await openTurn(store, id, inputs, {
    flow: flowLabel(body, bundle),
    record,
  });
  return { store, id, opened };
}

/** How a turn records that its flow came out of a bundle. */
const BUNDLE_LABEL = 'bundle:';
const INLINE_BUNDLE_LABEL = 'bundle:inline:';

/**
 * Refuse a resume that would continue a bundle's conversation with a
 * different program.
 *
 * The mirror of the CLI's repeat-your-plugin-flags rule: a resumed run needs
 * the bundle's flow, tools and plugins as much as the first turn did, and
 * nothing but the request can bring them back. Checked against what the
 * conversation recorded, before the checkpoint is read, so the refusal names
 * the bundle rather than surfacing as whatever a bundleless resume broke
 * first.
 */
function assertBundleRepeated(record: SessionRecord, body: RunRequest): void {
  const recorded = lastFlowLabel(record);
  if (recorded === undefined || !recorded.startsWith(BUNDLE_LABEL)) return;

  if (recorded.startsWith(INLINE_BUNDLE_LABEL)) {
    if (body.bundleData !== undefined) return;
    throw new HttpError(
      400,
      `this conversation was opened by a bundle sent inline ` +
        `("${recorded.slice(INLINE_BUNDLE_LABEL.length)}"). Resuming it needs ` +
        `the bundle's flow, tools and plugins — send the archive again as ` +
        `"bundleData".`,
    );
  }

  const id = recorded.slice(BUNDLE_LABEL.length);
  if (body.bundle === id) return;
  throw new HttpError(
    400,
    `this conversation belongs to bundle "${id}". Resume it with ` +
      `"bundle": "${id}" — the run needs the bundle's flow, tools and ` +
      `plugins, and a resume that brought its own would continue the ` +
      `conversation with a different program.`,
  );
}

/**
 * What this conversation was last run with, as its turns wrote it down.
 *
 * The most recent turn that has a label, because that is the program the
 * checkpoint being resumed came out of; the record's own `flow` is only a
 * creation-time hint and stands in when no turn has closed yet.
 */
function lastFlowLabel(record: SessionRecord): string | undefined {
  for (let i = record.turns.length - 1; i >= 0; i--) {
    const { flow } = record.turns[i];
    if (typeof flow === 'string') return flow;
  }
  return record.flow;
}

/**
 * Refuse the fields that only mean something inside a conversation.
 *
 * Ignoring them would leave a caller believing a run is recoverable when
 * nothing recorded it, which is the kind of mistake that is only discovered
 * when somebody tries to recover.
 */
function assertNoSessionOnlyFields(body: RunRequest): void {
  for (const field of ['durable', 'resume', 'answer'] as const) {
    if (body[field] !== undefined) {
      throw new HttpError(
        400,
        `"${field}" needs a "session". A run is written down in a ` +
          `conversation, so there is nowhere to put a checkpoint — or to find ` +
          `one — without naming which.`,
      );
    }
  }
}

/**
 * The sink this run writes through, if it belongs to a conversation.
 *
 * Present whenever there is a session, not only when the request asked to be
 * durable: a middleware may suspend the run, and a suspension with nowhere to
 * go is a run stopped with no way back. `durable` is what turns on the per-node
 * writes, which is the part that costs something.
 */
function checkpointsFor(
  plan: RunPlan,
): RunnerOptions['checkpoints'] | undefined {
  const { session } = plan;
  if (!session) return undefined;

  return checkpointSink({
    store: session.store,
    sessionId: session.id,
    runId: session.opened.runId,
    input: session.opened.input,
  });
}

function readAnswer(
  body: RunRequest,
  ask: Record<string, unknown>,
): Record<string, unknown> {
  const { answer } = body;
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
    throw new HttpError(
      400,
      `this run stopped for a human and is waiting on an answer to ` +
        `${JSON.stringify(ask)}. Send it as an "answer" object alongside ` +
        `"resume": true.`,
      'AnswerRequired',
    );
  }
  return answer;
}

/**
 * What a caller is told when a run stopped on a person.
 *
 * 202 rather than 200: the request was accepted and the work is not finished,
 * which is exactly what has happened. Not an error status — nothing failed, and
 * a client retrying on 4xx or 5xx would be retrying a run that is patiently
 * waiting for them.
 */
function sendSuspended(
  res: ServerResponse,
  plan: RunPlan,
  failure: RunSuspended,
): void {
  const { by, seam, ask, node } = failure.suspension;

  sendJson(
    res,
    202,
    {
      session: plan.session?.id,
      status: 'suspended',
      suspended: { by, seam, node, ask },
    },
    plan.headers,
  );
}

/**
 * What the turn records about where the flow came from.
 *
 * A path when the request named one, and the flow's own name when it inlined
 * the document — never the document itself. A transcript is read back by
 * somebody asking what this conversation was with, and a spec pasted into every
 * turn answers that question at the cost of making the file unreadable.
 *
 * A bundle is labelled by its id when the store holds it — the one name that
 * gets the same program back — and by its own name when it arrived inline,
 * where there is no id to repeat. {@link assertBundleRepeated} reads these
 * back.
 */
function flowLabel(body: RunRequest, bundle?: OpenedBundle): string | undefined {
  if (bundle) {
    return typeof body.bundle === 'string'
      ? `${BUNDLE_LABEL}${body.bundle}`
      : `${INLINE_BUNDLE_LABEL}${bundle.name}`;
  }

  const path = (body as { flowPath?: unknown }).flowPath;
  if (typeof path === 'string') return path;

  const flow = body.flow as { name?: unknown } | undefined;
  return typeof flow?.name === 'string' ? flow.name : undefined;
}

/** Record what the run came to, whichever way it ended. */
async function closeSession(
  session: SessionTurn | undefined,
  outcome: TurnOutcome,
): Promise<void> {
  if (!session) return;
  await closeTurn(session.store, session.id, session.opened, outcome);
}

function failureOutcome(err: unknown): TurnOutcome {
  const error = err instanceof Error ? err : new Error(String(err));
  return { error: { name: error.name, message: error.message } };
}

async function runBuffered(res: ServerResponse, plan: RunPlan): Promise<void> {
  let graph: CompiledGraph | undefined;
  let state: State;

  try {
    const prepared = await prepare(plan, IGNORE_EVENTS);
    graph = prepared.graph;

    const runner = new Runner(
      prepared.graph,
      runnerOptions(plan.config, IGNORE_EVENTS, prepared.middleware, plan),
    );
    state = await runner.run(plan.abort.signal, plan.inputs, plan.session?.from);
  } catch (err) {
    // A suspended run has not finished its turn, so nothing is recorded: the
    // turn stays open, its checkpoint holds the question, and the answer
    // continues it. Closing here would end a conversation that is mid-sentence.
    if (isSuspended(err)) {
      sendSuspended(res, plan, err);
      return;
    }
    // Recorded before it is rethrown. A session that dropped its failed turns
    // would answer the next message having forgotten the question that broke,
    // and would hold a version one behind what actually happened.
    await closeSession(plan.session, failureOutcome(err));
    throw err;
  }

  // Stripped on the session path so the answer a client is handed is the answer
  // that was kept — and so a client echoing it back into its next "inputs" is
  // not refused for bringing its own conversation to a session.
  const answer = plan.session
    ? withoutReserved(state.toData())
    : state.toData();

  await closeSession(plan.session, { output: answer });

  sendJson(
    res,
    200,
    {
      flow: graph.name,
      state: answer,
      ...(plan.session ? { session: plan.session.id } : {}),
    },
    plan.headers,
  );
}

async function runStreaming(
  res: ServerResponse,
  plan: RunPlan,
  protocol: string | null,
): Promise<void> {
  const sse = new SseStream(res, plan.headers);
  const encoder = resolveEncoder(protocol, plan.plugins);

  let events: EncoderStream | undefined;

  let prepared: Prepared;
  try {
    prepared = await prepare(plan, (event) => events?.offer(event));
  } catch (err) {
    await closeSession(plan.session, failureOutcome(err));
    const { status, body } = toErrorResponse(err);
    sendJson(res, status, body, plan.headers);
    return;
  }

  events = new EncoderStream(
    encoder.create(randomUUID()),
    (frame) => sse.sendFrame(frame),
    () => plan.abort.abort(),
  );

  sse.open(encoder.contentType);

  const runner = new Runner(
    prepared.graph,
    runnerOptions(plan.config, events.handler(), prepared.middleware, plan),
  );

  let failure: unknown;
  let state: State | undefined;
  try {
    state = await runner.run(plan.abort.signal, plan.inputs, plan.session?.from);
  } catch (err) {
    failure = err;
  }

  try {
    await events.close();
  } catch (err) {
    failure = err;
  }

  // A suspension is not the end of the turn: the checkpoint holds the question
  // and an answer continues it, so the transcript stays open. The frame is what
  // tells a streaming client the run stopped on purpose rather than just ended.
  if (isSuspended(failure)) {
    sse.send('suspended', {
      session: plan.session?.id,
      ...failure.suspension,
    });
    sse.close();
    return;
  }

  // Before the error frame, so a client that reads the session after seeing the
  // stream end finds the turn already recorded either way. A store that fails
  // here replaces the run's own failure, for the same reason `close()` does: it
  // is the more recent thing that went wrong and the one nothing else reports.
  try {
    await closeSession(
      plan.session,
      failure
        ? failureOutcome(failure)
        : { output: withoutReserved((state as State).toData()) },
    );
  } catch (err) {
    failure = err;
  }

  if (failure) {
    const { body } = toErrorResponse(failure);
    sse.send('error', body.error);
  }
  sse.close();
}

async function prepare(
  plan: RunPlan,
  eventHandler: (event: Event) => void,
): Promise<Prepared> {
  const flow = plan.bundle
    ? resolveBundleFlow(plan.bundle, plan.plugins)
    : resolveFlow(plan.body, plan.config, plan.plugins);
  const { deps, middleware } = buildDependencies(flow, plan, eventHandler);

  const graph = compile(flow, deps);
  validate(graph);
  return { graph, middleware };
}

function buildDependencies(
  flow: ParsedFlow,
  plan: RunPlan,
  eventHandler: (event: Event) => void,
): { deps: Dependencies; middleware: MiddlewareChain } {
  const { config } = plan;
  const registry = buildRegistry(config, plan);

  const toolNames = collectToolNames(flow);
  if (toolNames.length > 0) assertToolsAvailable(registry, toolNames);

  const deps: Dependencies = {
    toolExecutor: new SubprocessExecutor({
      sandbox: config.sandbox,
      workspaces: plan.workspaces,
      // Per run, because the registry is: a request may have submitted tools of
      // its own, and they belong in that run's workspaces and no others.
      tools: config.mountTools ? workspaceTools(registry) : [],
    }),
    toolRegistry: registry,
    plugins: plan.plugins,
    eventHandler,
    allowEnvRefs: !config.allowRequestCode,
    // The same condition, for the same reason, applied to the other thing a
    // submitted spec chooses. `allowEnvRefs` refuses it a value out of this
    // process; this refuses it a *destination* inside this network. A spec the
    // operator wrote is trusted with both.
    egress: config.allowRequestCode
      ? { allow: config.allowNet }
      : undefined,
    defaultLlmKey: config.defaultLlmKey,
    defaultLlmUrl: config.defaultLlmUrl,
    stream: config.stream,
  };

  // Per run, over a registry loaded once. A middleware is one object per run
  // holding that run's `Dependencies`, so the chain cannot be built at startup
  // and shared — but the processes behind it were, which is what an installed
  // plugin buys. Built from `plan.plugins` rather than `config.plugins` only
  // because that is the registry in hand; a submitted plugin declaring
  // middleware never reaches here, having been refused in `buildPlugins` — a
  // bundle's may, which is one of the rights a bundle runs with.
  const middleware = MiddlewareChain.build(
    plan.plugins,
    deps,
    pluginConfigFor(plan),
  );
  // On both, because the two reach different call sites — see the field's own
  // comment in `Dependencies`. Assigned after the build since the chain is made
  // *from* `deps`, and before `compile`, which makes the executors that read it.
  deps.middleware = middleware;

  return { deps, middleware };
}

function buildRegistry(config: ServerConfig, plan: RunPlan): Registry {
  // A bundle's tools directory rides where a request's would — the two are
  // mutually exclusive, so this is whichever one this run has, or neither.
  const toolsDir = plan.bundle?.toolsDir ?? plan.code.toolsDir;

  return standardRegistry({
    plugins: plan.plugins,
    toolsDir: config.toolsRegistry(),
    extra: toolsDir ? [FileRegistry.create(toolsDir)] : undefined,
  });
}

/**
 * The component settings this run's middleware is built from.
 *
 * A bundle's recorded settings underneath the operator's, so a bundle can
 * configure the middleware it carried while the operator's word stays final on
 * anything both name. `SERVER_SIDE_FIELDS` is untouched by this: what it
 * refuses is `pluginConfig` in the request *body*, and a bundle's arrived
 * inside the archive.
 */
function pluginConfigFor(
  plan: RunPlan,
): Record<string, Record<string, unknown>> {
  if (!plan.bundle) return plan.config.pluginConfig;
  return { ...plan.bundle.pluginConfig, ...plan.config.pluginConfig };
}

function runnerOptions(
  config: ServerConfig,
  eventHandler: (event: Event) => void,
  middleware: MiddlewareChain,
  plan: RunPlan,
): RunnerOptions {
  return {
    maxIterations: config.maxIterations,
    timeout: config.timeout,
    verbose: false,
    eventHandler,
    maxNodeAttempts: config.maxNodeAttempts,
    maxToolRounds: cappedToolRounds(plan.bundle, config.maxToolRounds),
    middleware,
    checkpoints: checkpointsFor(plan),
    durable: plan.body.durable === true || plan.body.resume === true,
  };
}

/**
 * The tool-round ceiling a bundle asked for, held under the operator's.
 *
 * Rights are not budget: a bundle runs with this server's full rights, but
 * `--max-tool-rounds` bounds what a run may spend of the server's own money,
 * and that stays the operator's whoever wrote the flow. A recorded number is
 * honored up to the cap; a recorded word ("unlimited" and its synonyms, which
 * the CLI would read as no ceiling at all) gets the cap itself — the closest
 * thing to unlimited this server sells.
 */
function cappedToolRounds(
  bundle: OpenedBundle | undefined,
  cap: number,
): number {
  const requested = bundle?.maxToolRounds;
  if (typeof requested !== 'number') return cap;
  return Math.min(requested, cap);
}

function readInputs(body: RunRequest): Record<string, unknown> {
  const inputs = body.inputs ?? {};
  if (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs)) {
    throw new HttpError(400, '"inputs" must be a JSON object');
  }
  return inputs;
}

function abortWhenClientHangsUp(res: ServerResponse): {
  controller: AbortController;
  finish: () => void;
} {
  const controller = new AbortController();
  let finished = false;

  res.on('close', () => {
    if (!finished) controller.abort();
  });

  return {
    controller,
    finish: () => {
      finished = true;
    },
  };
}

function rejectServerSideFields(body: Record<string, unknown>): void {
  for (const field of SERVER_SIDE_FIELDS) {
    if (field in body) {
      throw new HttpError(
        400,
        `"${field}" is server-side configuration and cannot be set per request`,
      );
    }
  }
}
