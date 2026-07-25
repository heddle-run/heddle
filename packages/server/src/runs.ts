import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  compile,
  validate,
  collectToolNames,
  FileRegistry,
  SubprocessExecutor,
  Runner,
  type Dependencies,
  type Event,
  type ParsedFlow,
  type RunnerOptions,
} from '@heddle/core';
import type { ServerConfig } from './config.js';
import { HttpError, toErrorResponse } from './errors.js';
import { resolveFlow, type FlowRequest } from './flow-source.js';
import { readJsonBody, sendJson } from './http.js';
import { SseStream, serializeEvent } from './sse.js';

interface RunRequest extends FlowRequest {
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

function buildDependencies(
  pf: ParsedFlow,
  config: ServerConfig,
  eventHandler: (e: Event) => void,
): Dependencies {
  const registry = FileRegistry.create(config.toolsDir ?? '');
  const toolNames = collectToolNames(pf);
  if (toolNames.length > 0) {
    try {
      registry.validateTools(toolNames);
    } catch (err) {
      // The submitted flow names tools this server cannot provide. That is a
      // mismatch between the request and the server's configuration, and the
      // caller is the one who can act on it.
      const message = err instanceof Error ? err.message : String(err);
      throw new HttpError(400, message, 'ToolError');
    }
  }

  return {
    toolExecutor: new SubprocessExecutor(),
    toolRegistry: registry,
    eventHandler,
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

/** POST /v1/runs — execute a flow and return the final state. */
export async function handleRun(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
  stream: boolean,
): Promise<void> {
  const body = await readJsonBody(req, config.maxBodyBytes);
  rejectServerSideFields(body);

  const runBody = body as RunRequest;
  const inputs = runBody.inputs ?? {};
  if (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs)) {
    throw new HttpError(400, '"inputs" must be a JSON object');
  }

  // Wire cancellation to the client: if the caller hangs up, stop the run
  // rather than leaving tool subprocesses and LLM calls in flight.
  const ac = new AbortController();
  let finished = false;
  res.on('close', () => {
    if (!finished) ac.abort();
  });

  if (stream) {
    await runStreaming(res, config, runBody, inputs, ac, () => {
      finished = true;
    });
    return;
  }

  const pf = resolveFlow(runBody, config);
  const deps = buildDependencies(pf, config, () => {});
  const graph = compile(pf, deps);
  validate(graph);

  const runner = new Runner(graph, runnerOptions(config, () => {}));
  const state = await runner.run(ac.signal, inputs);
  finished = true;

  sendJson(res, 200, { flow: graph.name, state: state.toData() });
}

async function runStreaming(
  res: ServerResponse,
  config: ServerConfig,
  runBody: RunRequest,
  inputs: Record<string, unknown>,
  ac: AbortController,
  markFinished: () => void,
): Promise<void> {
  const sse = new SseStream(res);

  // Compile before opening the stream: a bad flow is a request error and
  // deserves a real 4xx status, which is impossible once 200 headers are out.
  let graph;
  try {
    const pf = resolveFlow(runBody, config);
    const deps = buildDependencies(pf, config, (e) => sse.send(e.type, serializeEvent(e)));
    graph = compile(pf, deps);
    validate(graph);
  } catch (err) {
    markFinished();
    const { status, body } = toErrorResponse(err);
    sendJson(res, status, body);
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
    markFinished();
    sse.close();
  }
}
