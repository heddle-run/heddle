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
  type OpenedTurn,
  type ParsedFlow,
  type Registry,
  type RunnerOptions,
  type RunPosition,
  type RunSuspended,
  type SessionStore,
  type TurnOutcome,
  type WorkspaceFactory,
  type WorkspaceTool,
} from '@heddle/core';
import type { ServerConfig } from './config.js';
import { HttpError, toErrorResponse } from './errors.js';
import { resolveFlow, type FlowRequest } from './flow-source.js';
import { readJsonBody, sendJson } from './http.js';
import type { ConcurrencyGate } from './limits.js';
import { buildPlugins } from './plugins.js';
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
import { assertToolsAvailable, mergeRegistries } from './tools.js';

interface RunRequest extends FlowRequest, RequestCode {
  inputs?: Record<string, unknown>;
  session?: string;
  durable?: boolean;
  resume?: boolean;
  /** What to tell a run that stopped on a human, with "resume". */
  answer?: Record<string, unknown>;
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
  const body = await readJsonBody(req, config.maxBodyBytes);
  rejectServerSideFields(body);
  if (!config.allowRequestCode) rejectRequestCode(body);
  requireStreamFor(protocol, stream);

  const runBody = body as RunRequest;
  const inputs = readInputs(runBody);
  const release = gate.acquire();
  const abort = abortWhenClientHangsUp(res);

  let code: MaterializedCode = NO_CODE;
  let plugins = PluginRegistry.empty();
  let workspaces = config.workspaces;

  try {
    if (config.allowRequestCode) code = materializeRequestCode(runBody, config);
    // Unconditionally, because a run resolves against the installed plugins
    // whether or not it brought any of its own. `NO_CODE` contributes nothing,
    // so with request code refused this is the operator's layer alone.
    plugins = buildPlugins(config, code);
    // The same shape, for the same reason: the server's factory is built once
    // at startup and this layers the request's own files onto a copy of it. A
    // collision with something the operator mounted is refused here rather than
    // shadowing it, which is why it can be the caller's 400.
    workspaces = asBadRequest(() => config.workspaces.extend(code.mounts));

    // Before anything is compiled, so a session that is busy or unknown is
    // refused without the request having spent a graph on it — and so the
    // history is in the inputs the graph is then given.
    const session = await openSession(config, runBody, inputs);

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
    };

    if (stream) await runStreaming(res, plan, protocol);
    else await runBuffered(res, plan);
  } finally {
    abort.finish();
    plugins.dispose();
    // Removes the template assembled from this request's files and leaves the
    // operator's, which every other run is still using. The guard is for the
    // path where `extend` never ran: disposing the server's own factory here
    // would delete what every later run starts from.
    if (workspaces !== config.workspaces) workspaces.dispose();
    code.dispose();
    release();
  }
}

async function openSession(
  config: ServerConfig,
  body: RunRequest,
  inputs: Record<string, unknown>,
): Promise<SessionTurn | undefined> {
  if (body.session === undefined) {
    assertNoSessionOnlyFields(body);
    return undefined;
  }

  const { store, id } = await resolveSession(config, body.session);

  if (body.resume === true) {
    const resumed = await resumeTurn(store, id);
    const { suspension } = resumed.checkpoint;

    if (suspension) {
      const answer = readAnswer(body, suspension.ask);
      resumed.inputs = { ...resumed.inputs, ...resumeInputs(suspension, answer) };
    }

    return { store, id, opened: resumed, from: positionOf(resumed.checkpoint) };
  }

  const opened = await openTurn(store, id, inputs, { flow: flowLabel(body) });
  return { store, id, opened };
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
 */
function flowLabel(body: RunRequest): string | undefined {
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
  const flow = resolveFlow(plan.body, plan.config, plan.plugins);
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
  const registry = buildRegistry(config, plan.code, plan.plugins);

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
  // middleware never reaches here, having been refused in `buildPlugins`.
  const middleware = MiddlewareChain.build(
    plan.plugins,
    deps,
    config.pluginConfig,
  );
  // On both, because the two reach different call sites — see the field's own
  // comment in `Dependencies`. Assigned after the build since the chain is made
  // *from* `deps`, and before `compile`, which makes the executors that read it.
  deps.middleware = middleware;

  return { deps, middleware };
}

/**
 * Every tool, as something a workspace can put in `bin`.
 *
 * A tool a plugin answers over its own channel has no program to link and gets
 * a shim that says so, rather than being left out: `command not found` is the
 * wrong thing to tell a model about a tool that exists.
 */
function workspaceTools(registry: Registry): WorkspaceTool[] {
  return registry.all().map((tool) => ({
    name: tool.name,
    target: tool.impl.kind === 'path' ? tool.impl.path : undefined,
    servedBy: tool.impl.kind === 'plugin' ? tool.impl.plugin : undefined,
  }));
}

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
    middleware,
    checkpoints: checkpointsFor(plan),
    durable: plan.body.durable === true || plan.body.resume === true,
  };
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
