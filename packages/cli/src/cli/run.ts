import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { Command } from 'commander';
import {
  compile,
  validate,
  loadFlow,
  collectToolNames,
  propertyTitle,
  EncoderStream,
  FileRegistry,
  SubprocessExecutor,
  Runner,
  loadPlugins,
  createSandbox,
  composeRegistries,
  missingTools,
  PluginRegistry,
  MiddlewareChain,
  parsePluginConfig,
  SandboxError,
  DEFAULT_RUNNER_OPTIONS,
  type CompiledGraph,
  type Dependencies,
  type Registry,
  type RunnerOptions,
  type Event,
  type ParsedFlow,
  type Sandbox,
  type SandboxBackend,
} from '@heddle/core';
import { frameLine, resolveEncoder, type EncoderFactory } from './encoders.js';
import { createProgressWriter, renderEvent } from './progress.js';

const SANDBOX_BACKENDS = new Set(['auto', 'bubblewrap', 'seatbelt']);
const DEFAULT_SANDBOX_BACKEND = 'auto';
const DEFAULT_INPUT_KEY = 'query';

interface SafeOptions {
  safe?: boolean;
  sandbox?: string;
  allowRead: string[];
  allowWrite: string[];
  allowEnv: string[];
  denyNet?: boolean;
}

interface RunOptions extends SafeOptions {
  toolsDir?: string;
  input?: string;
  chat?: boolean;
  plugin?: string[];
  discoverTools?: boolean;
  pluginConfig?: string[];
  maxNodeAttempts?: string;
  stream?: boolean;
  protocol?: string;
}

export const runCommand = new Command('run')
  .description('Run an Agent Spec flow')
  .argument('<flow>', 'Path to flow JSON or YAML file')
  .option('--tools-dir <dir>', 'Directory containing tool executables')
  .option('--input <json>', 'Input JSON object')
  .option('--chat', 'Open an interactive chat session')
  .option(
    '--plugin <module>',
    'Plugin module providing custom component types (repeatable)',
    collect,
    [] as string[],
  )
  .option(
    '--discover-tools',
    'Let a plugin that declares "discoverTools" be started so heddle can ask what tools it has. Off by default: reading a manifest runs nothing.',
  )
  .option(
    '--plugin-config <type=json>',
    'Configuration for a host-configured component such as a middleware; ' +
      'value may be inline JSON or @file (repeatable)',
    collect,
    [] as string[],
  )
  .option(
    '--max-node-attempts <n>',
    'How many times one arrival at a node may be attempted when middleware retries',
  )
  .option(
    '--no-stream',
    'Ask the model for one buffered response instead of a token stream',
  )
  .option(
    '--protocol <name>',
    'Render the run through an installed encoder, one JSON frame per line on ' +
      'stdout, instead of the human progress output. "heddle" is heddle\'s own ' +
      'frames; any other name comes from a plugin',
  )
  .option('--safe', 'Run tools inside an OS sandbox')
  .option(
    '--sandbox <backend>',
    'Sandbox backend: auto, bubblewrap, seatbelt (requires --safe)',
  )
  .option(
    '--allow-read <path>',
    'Grant sandboxed tools read access to a path (repeatable)',
    collect,
    [] as string[],
  )
  .option(
    '--allow-write <path>',
    'Grant sandboxed tools write access to a path (repeatable)',
    collect,
    [] as string[],
  )
  .option(
    '--allow-env <name>',
    'Forward an environment variable into the sandbox (repeatable)',
    collect,
    [] as string[],
  )
  .option('--deny-net', 'Block network access for sandboxed tools')
  .action(async (flowPath: string, options: RunOptions, command: Command) => {
    const verbose = command.parent?.opts().verbose ?? false;

    const plugins = await loadPlugins(options.plugin, {
      discovery: options.discoverTools === true,
    });
    let interactive = false;
    try {
      interactive = await runFlow(flowPath, options, plugins, verbose);
    } finally {
      if (!interactive) plugins.dispose();
    }
  });

async function runFlow(
  flowPath: string,
  options: RunOptions,
  plugins: PluginRegistry,
  verbose: boolean,
): Promise<boolean> {
  const isChat = options.chat ?? false;
  // Before `loadFlow`, so two flags that cannot both hold are refused without
  // first blaming a file for it.
  const encoder = chooseEncoder(options.protocol, isChat, plugins);

  const flow = loadFlow(flowPath, plugins);
  const sandbox = buildSandbox(
    options,
    options.toolsDir,
    pluginToolPaths(plugins),
  );
  if (sandbox && verbose) {
    console.error(
      `Sandbox: ${sandbox.name}, network ${options.denyNet ? 'denied' : 'allowed'}`,
    );
  }

  const registry = buildRegistry(options, plugins);
  assertToolsAvailable(registry, collectToolNames(flow));

  const runnerOpts = buildRunnerOpts(verbose, !isChat && encoder === undefined);
  applyMaxNodeAttempts(runnerOpts, options.maxNodeAttempts);

  const deps: Dependencies = {
    toolExecutor: new SubprocessExecutor({ sandbox }),
    toolRegistry: registry,
    plugins,
    eventHandler: (event: Event) => runnerOpts.eventHandler?.(event),
    stream: options.stream,
  };

  runnerOpts.middleware = MiddlewareChain.build(
    plugins,
    deps,
    parsePluginConfig(options.pluginConfig),
  );
  // The same chain on both, because the two reach different call sites: the
  // runner consults `nodeError`, and an agent's tool loop consults `toolCall`
  // with only its `Dependencies` in hand. Assigned after the build rather than
  // in the literal above, since the chain is built *from* `deps` — and before
  // `compile`, which is where the executors that will read it are made.
  deps.middleware = runnerOpts.middleware;
  if (verbose && !runnerOpts.middleware.isEmpty()) {
    console.error(`Middleware: ${runnerOpts.middleware.describe().join('; ')}`);
  }

  const graph = compile(flow, deps);
  validate(graph);

  if (isChat) {
    await startChatSession(flowPath, flow, graph, runnerOpts, plugins);
    return true;
  }

  const inputs = parseInputs(options.input);
  if (encoder) {
    await runEncoded(graph, runnerOpts, encoder, inputs);
    return false;
  }

  const runner = new Runner(graph, runnerOpts);
  const result = await runner.run(undefined, inputs);
  console.log(JSON.stringify(result.toData(), null, 2));

  return false;
}

function chooseEncoder(
  protocol: string | undefined,
  isChat: boolean,
  plugins: PluginRegistry,
): EncoderFactory | undefined {
  if (protocol === undefined) return undefined;
  if (isChat) {
    throw new Error(
      '--protocol and --chat cannot be combined. --chat runs the flow once per ' +
        'message and paints the answers in a terminal UI, so there is no single ' +
        'stream of frames for an encoder to render and no stdout left to write ' +
        'them to. Drop one of the two.',
    );
  }

  return resolveEncoder(protocol, plugins);
}

/**
 * The final state is *not* printed here, unlike a plain run.
 *
 * With a protocol selected stdout is the frame stream, and a pretty-printed
 * object appended to it is a parse error for anything reading a frame per line.
 * Nothing is lost either: `flow_complete` carries the run's whole state, so an
 * encoder that wants to render the answer already has it.
 */
async function runEncoded(
  graph: CompiledGraph,
  runnerOpts: RunnerOptions,
  encoder: EncoderFactory,
  inputs: Record<string, unknown>,
): Promise<void> {
  const abort = new AbortController();
  const events = new EncoderStream(
    encoder(randomUUID()),
    (frame) => process.stdout.write(frameLine(frame)),
    () => abort.abort(),
  );
  runnerOpts.eventHandler = events.handler();

  const runner = new Runner(graph, runnerOpts);

  let failure: unknown;
  try {
    await runner.run(abort.signal, inputs);
  } catch (err) {
    failure = err;
  }

  // Awaited on both paths, so the queue is drained and `finish()` reaches the
  // encoder even when the run threw. `close()` rethrows an encoder that failed
  // mid-run, and that failure replaces the run's — the abort it triggered is
  // downstream of it, and "operation was aborted" is not the useful message.
  try {
    await events.close();
  } catch (err) {
    failure = err;
  }

  if (failure) throw failure;
}

async function startChatSession(
  flowPath: string,
  flow: ParsedFlow,
  graph: ReturnType<typeof compile>,
  runnerOpts: RunnerOptions,
  plugins: PluginRegistry,
): Promise<void> {
  const { createSession } = await import('../chat/session.js');
  const { startChat } = await import('../chat/ui.js');

  const session = createSession(flowPath);
  console.error(
    `Conversation saved to: ~/.heddle/conversations/${session.id}.json`,
  );

  disposeOnExit(plugins);
  startChat({
    graph,
    opts: runnerOpts,
    session,
    inputKey: detectInputKey(flow),
  });
}

function buildRegistry(
  options: RunOptions,
  plugins: PluginRegistry,
): Registry {
  return composeRegistries([
    plugins.toolRegistry(),
    FileRegistry.create(options.toolsDir ?? ''),
  ]);
}

function assertToolsAvailable(registry: Registry, names: string[]): void {
  const missing = missingTools(registry, names);
  if (missing.length > 0) {
    throw new Error(`missing executables for tools: ${missing.join(', ')}`);
  }
}

// Chat and an encoder each own the event stream — chat's UI reads it, an
// encoder renders it — so the progress writer belongs only to the run that has
// neither.
function buildRunnerOpts(verbose: boolean, progress: boolean): RunnerOptions {
  const opts = { ...DEFAULT_RUNNER_OPTIONS, verbose };
  if (!progress) return opts;

  const writeProgress = createProgressWriter((text) =>
    process.stderr.write(text),
  );
  opts.eventHandler = (event: Event) =>
    writeProgress(renderEvent(event, verbose));

  return opts;
}

function applyMaxNodeAttempts(
  opts: RunnerOptions,
  requested: string | undefined,
): void {
  if (requested === undefined) return;

  const attempts = Number(requested);
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error('--max-node-attempts must be a whole number of 1 or more');
  }
  opts.maxNodeAttempts = attempts;
}

function parseInputs(input: string | undefined): Record<string, unknown> {
  if (!input) return {};

  try {
    return JSON.parse(input);
  } catch (err) {
    throw new Error('failed to parse --input JSON', { cause: err });
  }
}

function detectInputKey(flow: ParsedFlow): string {
  for (const node of flow.parsedNodes) {
    if (node.componentType !== 'StartNode') continue;
    if (!node.outputs || node.outputs.length === 0) continue;

    const title = propertyTitle(node.outputs[0]);
    if (title) return title;
  }
  return DEFAULT_INPUT_KEY;
}

function buildSandbox(
  options: SafeOptions,
  toolsDir: string | undefined,
  pluginDirs: string[] = [],
): Sandbox | undefined {
  if (!options.safe) {
    assertNoSandboxTuning(options);
    return undefined;
  }

  const backend = options.sandbox ?? DEFAULT_SANDBOX_BACKEND;
  if (!SANDBOX_BACKENDS.has(backend)) {
    throw new SandboxError(
      `unknown sandbox backend "${backend}" (expected ${[...SANDBOX_BACKENDS].join(', ')})`,
    );
  }

  return createSandbox(backend as SandboxBackend, {
    readPaths: [
      ...(toolsDir ? [toolsDir] : []),
      ...pluginDirs,
      ...options.allowRead,
    ],
    writePaths: options.allowWrite,
    network: !options.denyNet,
    passEnv: options.allowEnv,
  });
}

function assertNoSandboxTuning(options: SafeOptions): void {
  const used = [
    options.sandbox !== undefined && '--sandbox',
    options.allowRead.length > 0 && '--allow-read',
    options.allowWrite.length > 0 && '--allow-write',
    options.allowEnv.length > 0 && '--allow-env',
    options.denyNet && '--deny-net',
  ].filter((flag): flag is string => typeof flag === 'string');

  if (used.length > 0) {
    throw new SandboxError(`${used.join(', ')} requires --safe`);
  }
}

function pluginToolPaths(plugins: PluginRegistry): string[] {
  const dirs = new Set<string>();

  for (const tool of plugins.toolRegistry().all()) {
    if (tool.impl.kind === 'path') dirs.add(dirname(tool.impl.path));
  }

  return [...dirs];
}

function disposeOnExit(plugins: PluginRegistry): void {
  let done = false;

  const stop = (): void => {
    if (done) return;
    done = true;
    plugins.dispose();
  };

  process.on('exit', stop);
  process.on('SIGINT', () => {
    stop();
    process.exit(0);
  });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
