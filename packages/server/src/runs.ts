import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  compile,
  validate,
  collectToolNames,
  FileRegistry,
  PluginRegistry,
  SubprocessExecutor,
  Runner,
  type CompiledGraph,
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
import { SseStream, serializeEvent } from './sse.js';
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
  for (const field of ['toolsDir', 'tools_dir', 'flowsRoot', 'flows_root']) {
    if (field in body) {
      throw new HttpError(
        400,
        `"${field}" is server-side configuration and cannot be set per request`,
      );
    }
  }
}

/** The tools this run can reach: the server's, plus any the request submitted. */
function buildRegistry(config: ServerConfig, code: MaterializedCode): Registry {
  const registries: Registry[] = [FileRegistry.create(config.toolsDir ?? '')];
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
  const registry = buildRegistry(config, code);

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
  headers: Record<string, string> = {},
): Promise<void> {
  const body = await readJsonBody(req, config.maxBodyBytes);
  rejectServerSideFields(body);
  if (!config.allowRequestCode) rejectRequestCode(body);

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
      await runStreaming(res, config, runBody, inputs, code, plugins, ac, headers);
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
  headers: Record<string, string>,
): Promise<void> {
  const sse = new SseStream(res, headers);

  // Compile before opening the stream: a bad flow is a request error and
  // deserves a real 4xx status, which is impossible once 200 headers are out.
  let graph: CompiledGraph;
  try {
    graph = await prepare(runBody, config, code, plugins, (e) =>
      sse.send(e.type, serializeEvent(e)),
    );
  } catch (err) {
    const { status, body } = toErrorResponse(err);
    sendJson(res, status, body, headers);
    return;
  }

  sse.open();

  const opts = runnerOptions(config, (e) => sse.send(e.type, serializeEvent(e)));
  const runner = new Runner(graph, opts);

  try {
    await runner.run(ac.signal, inputs);
  } catch (err) {
    // Headers are already sent, so failures travel as an `error` frame. This
    // is the transport's error channel, not a second event model: engine
    // failures that have a runner event (node_error) have already been sent.
    const { body } = toErrorResponse(err);
    sse.send('error', body.error);
  } finally {
    sse.close();
  }
}
