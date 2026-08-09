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
  SubprocessExecutor,
  Runner,
  loadPlugins,
  checkpointSink,
  closeTurn,
  isSuspended,
  openTurn,
  positionOf,
  resumeInputs,
  withoutReserved,
  workspaceTools,
  resumeTurn,
  RunSuspended,
  PluginRegistry,
  MiddlewareChain,
  parsePluginConfig,
  assertToolsAvailable,
  envRequirements,
  sandboxFromOptions,
  standardRegistry,
  workspacesFromOptions,
  DEFAULT_MOUNT_MAX_BYTES,
  DEFAULT_MOUNT_MAX_ENTRIES,
  DEFAULT_RUNNER_OPTIONS,
  isBundlePath,
  State,
  type CompiledGraph,
  type Dependencies,
  type RunnerOptions,
  type Event,
  type ParsedFlow,
  type RunPosition,
  type SandboxOptions,
  type TurnOutcome,
  type WorkspaceOptions,
} from '@heddle-run/core';
import {
  downloadBundle,
  isRemotePath,
  mergeBundleOptions,
  openBundle,
  type OpenedBundle,
} from './bundles.js';
import { frameLine, resolveEncoder, type EncoderFactory } from './encoders.js';
import { askForEnvRefs } from './env-prompt.js';
import { waitForRequirements } from './preflight-prompt.js';
import { createProgressWriter, renderEvent } from './progress.js';
import { selectSession, type SelectedSession, type SessionFlags } from './sessions.js';

const DEFAULT_INPUT_KEY = 'query';

interface RunOptions extends SandboxOptions, WorkspaceOptions, SessionFlags {
  toolsDir?: string;
  mountTools?: boolean;
  askEnv?: boolean;
  preflight?: boolean;
  input?: string;
  interactive?: boolean;
  durable?: boolean;
  resume?: boolean;
  answer?: string;
  plugin?: string[];
  discoverTools?: boolean;
  pluginConfig?: string[];
  maxNodeAttempts?: string;
  maxToolRounds?: string;
  stream?: boolean;
  protocol?: string;
  format?: string;
}

export const runCommand = new Command('run')
  .description('Run an Agent Spec flow')
  .argument(
    '<flow>',
    'Path to flow JSON or YAML file, a .heddle bundle made by ' +
      '"heddle bundle", or an https:// address of one',
  )
  .option('--tools-dir <dir>', 'Directory containing tool executables')
  .option('--input <json>', 'Input JSON object')
  .option(
    '--format <name>',
    'Read the flow through this input format instead of resolving it from ' +
      'the file extension. "json" and "yaml" are builtin; any other name ' +
      'comes from a plugin',
  )
  .option(
    '--session [id]',
    'Keep this run in a conversation on disk, and give the agent the ones ' +
      'before it. With no id a new session is created and its id printed; ' +
      'with one, that session continues',
  )
  .option('--session-dir <dir>', 'Where sessions are kept')
  .option(
    '--durable',
    'Write the run down at every node boundary, so it can be resumed if the ' +
      'process dies. Costs one store write per node, so it is asked for rather ' +
      'than implied by --session',
  )
  .option(
    '--resume',
    "Continue this session's unfinished run instead of starting a new turn",
  )
  .option(
    '--answer <json>',
    'What to tell a run that stopped on a human, with --resume. Whatever the ' +
      'middleware that stopped it asked for',
  )
  .option(
    '-i, --interactive',
    'Open the terminal chat UI. Combine with --session to keep the ' +
      'conversation, and to pick it up again later',
  )
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
    '--max-tool-rounds <n>',
    'Most model responses one agent node may use, the answer included ' +
      '(default 10). Raise it for an agent whose tool loop is legitimately ' +
      'long, or "unlimited" to run until the model stops calling tools.',
  )
  .option(
    '--no-stream',
    'Ask the model for one buffered response instead of a token stream',
  )
  .option(
    '--no-preflight',
    "Start the run without checking the bundle's declared requirements. They " +
      'are the author\'s description of your machine, and when it is wrong — a ' +
      'browser somewhere they did not think of — this is how you say so',
  )
  .option(
    '--no-ask-env',
    'Never ask for an environment variable the spec names and this shell does ' +
      'not have. Without it a terminal is asked before the run starts; the ' +
      'answer lives in this process only',
  )
  .option(
    '--protocol <name>',
    'Render the run through an installed encoder, one JSON frame per line on ' +
      'stdout, instead of the human progress output. "heddle" is heddle\'s own ' +
      'frames; any other name comes from a plugin',
  )
  .option(
    '--mount <src[:dest][:ro|:rw]>',
    'Put a file or directory in every workspace. "ro" (the default) is a copy ' +
      'the run cannot carry back; "rw" copies changed files out again when a ' +
      'node finishes (repeatable)',
    collect,
    [] as string[],
  )
  .option(
    '--workspace <dir>',
    'Keep each node\'s workspace under this directory instead of a temporary ' +
      'one, so what the run produced is still there afterwards',
  )
  .option(
    '--mount-max-bytes <n>',
    `Largest a --mount may be, in bytes (default ${DEFAULT_MOUNT_MAX_BYTES})`,
  )
  .option(
    '--mount-max-entries <n>',
    `Most files and directories a --mount may hold (default ${DEFAULT_MOUNT_MAX_ENTRIES})`,
  )
  .option(
    '--no-mount-tools',
    'Keep the tools out of the workspace, so the only way to reach one is a ' +
      'call the model made. Costs a tool the ability to run a peer; buys back ' +
      'the guarantee that every tool call passes the toolCall seam',
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

    // A URL is a download first and a bundle second: fetched to a temporary
    // file, then opened exactly as a local archive would be. The download is
    // disposed of unconditionally below — extraction has happened by then, so
    // even an interactive run, which keeps its extraction, is done with it.
    const fetched = isRemotePath(flowPath)
      ? await downloadBundle(flowPath)
      : undefined;
    const archivePath = fetched?.path ?? flowPath;

    let interactive = false;
    try {
      // Opened before the plugins load, because the bundle is where some of
      // them come from. What it recorded becomes defaults in the same options
      // the flags parse into, so everything below this line is one code path.
      const bundle = isBundlePath(archivePath)
        ? openBundle(archivePath)
        : undefined;
      // Before the merge writes the bundle's recorded input into `options`,
      // while `--input` still means only what the caller themselves typed.
      honourBundleChat(options, bundle);
      if (bundle) mergeBundleOptions(options, bundle);

      try {
        const plugins = await loadPlugins(options.plugin, {
          discovery: options.discoverTools === true,
        });
        try {
          interactive = await runFlow(
            bundle?.flowPath ?? archivePath,
            options,
            plugins,
            verbose,
            bundle,
          );
        } finally {
          if (!interactive) plugins.dispose();
        }
      } finally {
        // An interactive run keeps its extraction: the chat UI outlives this
        // action, and its flow, tools and mounts live in that directory.
        if (!interactive) bundle?.dispose();
      }
    } finally {
      fetched?.dispose();
    }
  });

async function runFlow(
  flowPath: string,
  options: RunOptions,
  plugins: PluginRegistry,
  verbose: boolean,
  bundle?: OpenedBundle,
): Promise<boolean> {
  const interactive = options.interactive ?? false;
  // Before `loadFlow`, so two flags that cannot both hold are refused without
  // first blaming a file for it.
  const encoder = chooseEncoder(options.protocol, interactive, plugins);
  const session = selectSession(options);
  assertSessionFlags(options, session);

  const flow = loadFlow(flowPath, plugins, { format: options.format });
  // Before the sandbox, because a `--workspace` directory has to be on the
  // policy's write paths and the policy is fixed once the sandbox is made.
  const workspaces = workspacesFromOptions(
    options,
    plugins,
    (message) => console.error(message),
    bundle?.mounts ?? [],
  );
  const sandbox = sandboxFromOptions(
    options,
    options.toolsDir,
    pluginToolPaths(plugins),
  );
  if (sandbox && verbose) {
    console.error(
      `Sandbox: ${sandbox.name}, network ${options.denyNet ? 'denied' : 'allowed'}`,
    );
  }

  const registry = standardRegistry({ plugins, toolsDir: options.toolsDir });
  assertToolsAvailable(registry, collectToolNames(flow));

  const runnerOpts = buildRunnerOpts(
    verbose,
    !interactive && encoder === undefined,
  );
  applyMaxNodeAttempts(runnerOpts, options.maxNodeAttempts);
  applyMaxToolRounds(runnerOpts, options.maxToolRounds);

  const deps: Dependencies = {
    toolExecutor: new SubprocessExecutor({
      sandbox,
      workspaces,
      tools: options.mountTools === false ? [] : workspaceTools(registry),
    }),
    toolRegistry: registry,
    plugins,
    eventHandler: (event: Event) => runnerOpts.eventHandler?.(event),
    stream: options.stream,
    maxToolRounds: runnerOpts.maxToolRounds,
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

  // After everything that can be decided from the spec and the flags, and
  // before anything that runs: a spec that will be refused should be refused
  // without first asking somebody to type a key into it. Also before the chat
  // UI, which takes the terminal this question is asked on.
  //
  // A bundle's declared `env` requirements are asked for here too, and the
  // check below runs after: on a terminal, "OPENAI_API_KEY is not set" is a
  // question worth asking before it is a refusal worth printing, and an answer
  // typed here satisfies the requirement it was asked for.
  if (options.askEnv !== false) {
    await askForEnvRefs(flow, { also: envRequirements(bundle?.requires ?? []) });
  }

  // The other half of the tool check above — what the machine has to bring
  // itself — held back to here so the questions come before the refusal.
  // Everything after this line starts something; nothing before it did.
  //
  // On a terminal an unmet requirement is a pause, not an exit: fix it in
  // another shell, press enter, and the run that was typed still happens.
  // Anywhere else it is the hard refusal `heddle doctor` prints. Named for the
  // bundle rather than the flow inside it, because the reader typed the
  // bundle's name and has never seen the other one.
  //
  // Declined with --no-preflight, and that is not a hole in anything: a
  // requirement is a bundle author's description of a machine they have never
  // seen, so the operator standing at that machine gets the last word — the
  // same way `--discover-tools` leaves them the one about starting a process.
  if (options.preflight !== false) {
    await waitForRequirements(bundle?.requires ?? [], bundle?.name ?? flow.name);
  }

  if (interactive) {
    await startChatSession(flowPath, flow, graph, runnerOpts, plugins, session);
    return true;
  }

  const inputs = parseInputs(options.input);

  if (session) {
    await runTurn(graph, runnerOpts, encoder, session, flowPath, inputs, {
      durable: options.durable ?? false,
      resume: options.resume ?? false,
      answer: parseAnswer(options.answer),
    });
    return false;
  }

  const state = await runOnce(graph, runnerOpts, encoder, inputs);
  if (!encoder) console.log(JSON.stringify(state.toData(), null, 2));

  return false;
}

/**
 * Refuse the flags that only mean something inside a conversation.
 *
 * `--durable` and `--resume` both name a place to write to or read from, and
 * without `--session` there is none. Silently ignoring them would make a run
 * the caller believes is recoverable one that is not.
 */
function assertSessionFlags(
  options: RunOptions,
  session: SelectedSession | undefined,
): void {
  if (session) return;

  const orphaned = [
    options.durable && '--durable',
    options.resume && '--resume',
    options.answer !== undefined && '--answer',
  ].filter((flag): flag is string => typeof flag === 'string');

  if (orphaned.length > 0) {
    throw new Error(
      `${orphaned.join(' and ')} needs --session. A run is written down in a ` +
        `conversation, so there is nowhere to put a checkpoint — or to find ` +
        `one — without naming which.`,
    );
  }
}

/**
 * One run, recorded in a conversation.
 *
 * The turn is closed on both paths, and a failure is recorded before it is
 * rethrown: a session that dropped its failed turns would answer the next
 * message having forgotten the question that broke, and the version its next
 * turn opens against would be one behind what actually happened.
 */
async function runTurn(
  graph: CompiledGraph,
  runnerOpts: RunnerOptions,
  encoder: EncoderFactory | undefined,
  session: SelectedSession,
  flowPath: string,
  inputs: Record<string, unknown>,
  mode: {
    durable: boolean;
    resume: boolean;
    answer: Record<string, unknown> | undefined;
  },
): Promise<void> {
  const { store, id } = session;
  const resumed = mode.resume ? await resumeTurn(store, id) : undefined;
  const opened =
    resumed ?? (await openTurn(store, id, inputs, { flow: flowPath }));
  if (session.fresh) console.error(`Session: ${id}`);

  const from = resumed ? positionOf(resumed.checkpoint) : undefined;
  // Whenever the run has a conversation, not only when it asked to be durable:
  // a middleware may suspend it, and a suspension with nowhere to go is a run
  // stopped with no way back. `durable` is what turns on the per-node writes.
  runnerOpts.checkpoints = checkpointSink({
    store,
    sessionId: id,
    runId: opened.runId,
    input: opened.input,
  });
  runnerOpts.durable = mode.durable || mode.resume;

  const started = resumed
    ? resumedInputs(resumed, mode.answer)
    : opened.inputs;

  let outcome: TurnOutcome;
  let failure: unknown;
  try {
    const state = await runOnce(graph, runnerOpts, encoder, started, from);
    // Stripped here as well as in `closeTurn`, so what is printed is what is
    // kept. A flow that passes its state through hands back the history heddle
    // injected, and a caller who copied that into their next --input would be
    // refused for bringing their own conversation to a session.
    outcome = { output: withoutReserved(state.toData()) };
  } catch (err) {
    failure = err;
    const error = err instanceof Error ? err : new Error(String(err));
    outcome = { error: { name: error.name, message: error.message } };
  }

  // A suspended run has not finished its turn, so nothing is recorded: the turn
  // stays open, its checkpoint holds the question, and the answer continues it.
  // Appending here would close a conversation that is mid-sentence.
  if (isSuspended(failure)) {
    // With a protocol selected, stdout is the frame stream, so the suspension
    // goes there as a frame — heddle's own, like the server's `suspended`
    // event, rather than something the encoder produced. The human-readable
    // version still goes to stderr, where it does not corrupt the stream.
    if (encoder) {
      process.stdout.write(
        frameLine({
          event: 'suspended',
          data: { session: id, ...failure.suspension },
        }),
      );
    }
    reportSuspension(id, failure);
    return;
  }

  await closeTurn(store, id, opened, outcome);

  if (failure) {
    console.error(resumeHint(id));
    throw failure;
  }
  if (!encoder) console.log(JSON.stringify(outcome.output, null, 2));
}

/**
 * The inputs a resumed run starts with.
 *
 * A suspended run gets the answer, addressed to the node that asked. A run cut
 * at a node boundary gets nothing extra — there was no question, and the state
 * it needs is all in the checkpoint.
 */
function resumedInputs(
  resumed: Awaited<ReturnType<typeof resumeTurn>>,
  answer: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const { suspension } = resumed.checkpoint;
  if (!suspension) return resumed.inputs;

  if (answer === undefined) {
    throw new Error(
      `this run stopped for a human: "${suspension.by}" is waiting on an ` +
        `answer to ${JSON.stringify(suspension.ask)}. Continue it with ` +
        `--answer '<json>'.`,
    );
  }

  return { ...resumed.inputs, ...resumeInputs(suspension, answer) };
}

function reportSuspension(id: string, failure: RunSuspended): void {
  const { by, ask } = failure.suspension;
  console.error(
    `\nStopped for a human: "${by}" is asking.\n` +
      `${JSON.stringify(ask, null, 2)}\n\n` +
      `Answer it with:\n` +
      `  heddle run <flow> --session ${id} --resume --answer '{"approved":true}'`,
  );
}

function parseAnswer(
  raw: string | undefined,
): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error('failed to parse --answer JSON', { cause: err });
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      '--answer must be a JSON object. It is handed to the run as the result ' +
        'of the call that was waiting, and a tool result is an object of ' +
        'named values — wrap a bare value as {"approved": true}.',
    );
  }
  return parsed as Record<string, unknown>;
}

function resumeHint(id: string): string {
  return (
    `The run was checkpointed before it failed. Continue it with ` +
    `--session ${id} --resume, or drop it with "heddle sessions rm ${id}".`
  );
}

function runOnce(
  graph: CompiledGraph,
  runnerOpts: RunnerOptions,
  encoder: EncoderFactory | undefined,
  inputs: Record<string, unknown>,
  from?: RunPosition,
): Promise<State> {
  return encoder
    ? runEncoded(graph, runnerOpts, encoder, inputs, from)
    : new Runner(graph, runnerOpts).run(undefined, inputs, from);
}

function chooseEncoder(
  protocol: string | undefined,
  interactive: boolean,
  plugins: PluginRegistry,
): EncoderFactory | undefined {
  if (protocol === undefined) return undefined;
  if (interactive) {
    throw new Error(
      '--protocol and --interactive cannot be combined. The chat UI paints the ' +
        'answers in the terminal, so there is no single stream of frames for an ' +
        'encoder to render and no stdout left to write them to. Drop one of the ' +
        'two — a run that wants both a transcript and an encoder wants ' +
        '--session, which composes with --protocol.',
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
 *
 * It is still *returned*, because a session records the state rather than
 * rendering it — and a run under `--protocol --session` would otherwise write a
 * turn with no answer in it.
 */
async function runEncoded(
  graph: CompiledGraph,
  runnerOpts: RunnerOptions,
  encoder: EncoderFactory,
  inputs: Record<string, unknown>,
  from?: RunPosition,
): Promise<State> {
  const abort = new AbortController();
  const events = new EncoderStream(
    encoder(randomUUID()),
    (frame) => process.stdout.write(frameLine(frame)),
    () => abort.abort(),
  );
  runnerOpts.eventHandler = events.handler();

  const runner = new Runner(graph, runnerOpts);

  let failure: unknown;
  let state: State | undefined;
  try {
    state = await runner.run(abort.signal, inputs, from);
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
  return state as State;
}

/**
 * The chat UI, over a session when one was asked for and over nothing when not.
 *
 * `--interactive` alone is a conversation that lives as long as the terminal
 * does. That is what the flag this replaced always was — it wrote a transcript
 * nothing ever read back, so restarting started over regardless. Naming a
 * session is now what makes it durable, and the UI seeds itself from the store
 * rather than from its own memory.
 */
async function startChatSession(
  flowPath: string,
  flow: ParsedFlow,
  graph: ReturnType<typeof compile>,
  runnerOpts: RunnerOptions,
  plugins: PluginRegistry,
  session: SelectedSession | undefined,
): Promise<void> {
  const { startChat } = await import('../chat/ui.js');

  const opened = session
    ? { store: session.store, id: session.id, turns: await priorTurns(session) }
    : undefined;

  if (opened) {
    console.error(
      opened.turns.length > 0
        ? `Session: ${opened.id} (${opened.turns.length} turns so far)`
        : `Session: ${opened.id}`,
    );
  }

  disposeOnExit(plugins);
  startChat({
    graph,
    opts: runnerOpts,
    session: opened,
    flowPath,
    inputKey: detectInputKey(flow),
  });
}

async function priorTurns(session: SelectedSession) {
  const record = await session.store.read(session.id);
  return record?.turns ?? [];
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

/** The words `--max-tool-rounds` accepts for "no ceiling at all". */
const UNLIMITED_ROUNDS = new Set(['unlimited', 'none', 'infinite', 'inf']);

export function applyMaxToolRounds(
  opts: RunnerOptions,
  requested: string | undefined,
): void {
  if (requested === undefined) return;

  if (UNLIMITED_ROUNDS.has(requested.trim().toLowerCase())) {
    // No ceiling: the agent loop then ends only when the model stops calling
    // tools and answers. A runaway model runs until it does, or until Ctrl+C —
    // which is the trade the operator asked for by naming it.
    opts.maxToolRounds = Infinity;
    return;
  }

  const rounds = Number(requested);
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new Error(
      '--max-tool-rounds must be a whole number of 1 or more, or "unlimited"',
    );
  }
  opts.maxToolRounds = rounds;
}

/**
 * Open the chat UI for a bundle that recorded `interactive` — when nothing
 * the caller typed says otherwise.
 *
 * The bundle proposes, the command line disposes, and so does the terminal:
 * an explicit `--input` is an instruction to run that task once, an encoder
 * owns stdout, a resume is answering a suspended run, `-i` already decided,
 * and a pipe has nobody at the keyboard. Every override is silent except the
 * pipe, which gets one line saying why the chat-first bundle ran once —
 * that fallback is the one that would otherwise read as the bundle being
 * broken in CI logs.
 *
 * Called before `mergeBundleOptions`, so `options.input` here is only ever
 * the caller's own; the bundle's recorded input is the chat's loss, not its
 * veto.
 */
export function honourBundleChat(
  options: RunOptions,
  bundle: OpenedBundle | undefined,
  tty = process.stdin.isTTY === true && process.stdout.isTTY === true,
): void {
  if (!bundle?.interactive) return;
  if (options.interactive !== undefined) return;
  if (options.input !== undefined) return;
  if (options.protocol !== undefined) return;
  if (options.resume || options.answer !== undefined) return;

  if (!tty) {
    console.error(
      `"${bundle.name}" opens a chat when run at a terminal. No terminal ` +
        `here, so it runs its recorded input once instead.`,
    );
    return;
  }

  options.interactive = true;
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
