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

interface RunPlan {
  config: ServerConfig;
  body: RunRequest;
  inputs: Record<string, unknown>;
  code: MaterializedCode;
  plugins: PluginRegistry;
  abort: AbortController;
  headers: Record<string, string>;
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

  try {
    if (config.allowRequestCode) {
      code = materializeRequestCode(runBody, config);
      plugins = buildPlugins(config, code);
    }

    const plan: RunPlan = {
      config,
      body: runBody,
      inputs,
      code,
      plugins,
      abort: abort.controller,
      headers,
    };

    if (stream) await runStreaming(res, plan, protocol);
    else await runBuffered(res, plan);
  } finally {
    abort.finish();
    plugins.dispose();
    code.dispose();
    release();
  }
}

async function runBuffered(res: ServerResponse, plan: RunPlan): Promise<void> {
  const graph = await prepare(plan, IGNORE_EVENTS);
  const runner = new Runner(graph, runnerOptions(plan.config, IGNORE_EVENTS));
  const state = await runner.run(plan.abort.signal, plan.inputs);

  sendJson(
    res,
    200,
    { flow: graph.name, state: state.toData() },
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

  let graph: CompiledGraph;
  try {
    graph = await prepare(plan, (event) => events?.offer(event));
  } catch (err) {
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
    graph,
    runnerOptions(plan.config, events.handler()),
  );

  let failure: unknown;
  try {
    await runner.run(plan.abort.signal, plan.inputs);
  } catch (err) {
    failure = err;
  }

  try {
    await events.close();
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
): Promise<CompiledGraph> {
  const flow = resolveFlow(plan.body, plan.config, plan.plugins);
  const deps = buildDependencies(flow, plan, eventHandler);

  const graph = compile(flow, deps);
  validate(graph);
  return graph;
}

function buildDependencies(
  flow: ParsedFlow,
  plan: RunPlan,
  eventHandler: (event: Event) => void,
): Dependencies {
  const { config } = plan;
  const registry = buildRegistry(config, plan.code, plan.plugins);

  const toolNames = collectToolNames(flow);
  if (toolNames.length > 0) assertToolsAvailable(registry, toolNames);

  return {
    toolExecutor: new SubprocessExecutor({ sandbox: config.sandbox }),
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
): RunnerOptions {
  return {
    maxIterations: config.maxIterations,
    timeout: config.timeout,
    verbose: false,
    eventHandler,
    maxNodeAttempts: DEFAULT_RUNNER_OPTIONS.maxNodeAttempts,
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
