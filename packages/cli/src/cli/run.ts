import { Command } from 'commander';
import {
  compile,
  validate,
  loadFlow,
  collectToolNames,
  propertyTitle,
  FileRegistry,
  SubprocessExecutor,
  Runner,
  loadPlugins,
  createSandbox,
  SandboxError,
  DEFAULT_RUNNER_OPTIONS,
  type RunnerOptions,
  type Event,
  type ParsedFlow,
  type Sandbox,
  type SandboxBackend,
} from '@heddle/core';
import { createProgressWriter, renderEvent } from './progress.js';

/** Accumulates a repeatable commander flag into an array. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

interface SafeOptions {
  safe?: boolean;
  sandbox?: string;
  allowRead: string[];
  allowWrite: string[];
  allowEnv: string[];
  denyNet?: boolean;
}

const SANDBOX_BACKENDS = new Set(['auto', 'bubblewrap', 'seatbelt']);

/**
 * Builds the sandbox for this run, or undefined when --safe was not given.
 * The --allow-* and --deny-net flags only shape a sandbox, so using one
 * without --safe is a mistake worth reporting rather than ignoring.
 */
function buildSandbox(
  options: SafeOptions,
  toolsDir: string | undefined,
): Sandbox | undefined {
  const tuning = [
    options.sandbox !== undefined && '--sandbox',
    options.allowRead.length > 0 && '--allow-read',
    options.allowWrite.length > 0 && '--allow-write',
    options.allowEnv.length > 0 && '--allow-env',
    options.denyNet && '--deny-net',
  ].filter((f): f is string => typeof f === 'string');

  if (!options.safe) {
    if (tuning.length > 0) {
      throw new SandboxError(`${tuning.join(', ')} requires --safe`);
    }
    return undefined;
  }

  const backend = options.sandbox ?? 'auto';
  if (!SANDBOX_BACKENDS.has(backend)) {
    throw new SandboxError(
      `unknown sandbox backend "${backend}" (expected ${[...SANDBOX_BACKENDS].join(', ')})`,
    );
  }

  return createSandbox(backend as SandboxBackend, {
    // The tools directory is read-only inside the sandbox: a tool can be run,
    // but cannot rewrite itself or its siblings.
    readPaths: [...(toolsDir ? [toolsDir] : []), ...options.allowRead],
    writePaths: options.allowWrite,
    network: !options.denyNet,
    passEnv: options.allowEnv,
  });
}

function buildRunnerOpts(verbose: boolean, chat: boolean): RunnerOptions {
  const opts = { ...DEFAULT_RUNNER_OPTIONS, verbose };
  if (!chat) {
    // Progress goes to stderr, so the run's JSON result on stdout stays clean
    // and pipeable.
    const writeProgress = createProgressWriter((text) => process.stderr.write(text));
    opts.eventHandler = (e: Event) => writeProgress(renderEvent(e, verbose));
  }
  return opts;
}

/** Determine the primary input key from the flow's StartNode outputs. */
function detectInputKey(pf: ParsedFlow): string {
  for (const n of pf.parsedNodes) {
    if (n.componentType === 'StartNode' && n.outputs && n.outputs.length > 0) {
      const title = propertyTitle(n.outputs[0]);
      if (title) return title;
    }
  }
  return 'query';
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
  .option('--safe', 'Run tools inside an OS sandbox')
  .option('--sandbox <backend>', 'Sandbox backend: auto, bubblewrap, seatbelt (requires --safe)')
  .option('--allow-read <path>', 'Grant sandboxed tools read access to a path (repeatable)', collect, [] as string[])
  .option('--allow-write <path>', 'Grant sandboxed tools write access to a path (repeatable)', collect, [] as string[])
  .option('--allow-env <name>', 'Forward an environment variable into the sandbox (repeatable)', collect, [] as string[])
  .option('--deny-net', 'Block network access for sandboxed tools')
  .action(
    async (
      flowPath: string,
      options: {
        toolsDir?: string;
        input?: string;
        chat?: boolean;
        plugin?: string[];
      } & SafeOptions,
      command: Command,
    ) => {
      const verbose = command.parent?.opts().verbose ?? false;

      // Built before anything else so a bad sandbox setup fails before the
      // run has a chance to execute an unconfined tool.
      const sandbox = buildSandbox(options, options.toolsDir);
      if (sandbox && verbose) {
        console.error(
          `Sandbox: ${sandbox.name}, network ${options.denyNet ? 'denied' : 'allowed'}`,
        );
      }

      const plugins = await loadPlugins(options.plugin);
      const pf = loadFlow(flowPath, plugins);

      const reg = FileRegistry.create(options.toolsDir ?? '');
      const toolNames = collectToolNames(pf);
      if (toolNames.length > 0) {
        reg.validateTools(toolNames);
      }

      const isChat = options.chat ?? false;
      const opts = buildRunnerOpts(verbose, isChat);

      const deps = {
        toolExecutor: new SubprocessExecutor({ sandbox }),
        toolRegistry: reg,
        plugins,
        eventHandler: (e: Event) => opts.eventHandler?.(e),
      };

      const cg = compile(pf, deps);
      validate(cg);

      if (isChat) {
        const { createSession } = await import('../chat/session.js');
        const { startChat } = await import('../chat/ui.js');
        const session = createSession(flowPath);
        const inputKey = detectInputKey(pf);

        console.error(`Conversation saved to: ~/.heddle/conversations/${session.id}.json`);
        startChat({ graph: cg, opts, session, inputKey });
        return;
      }

      let inputs: Record<string, unknown>;
      if (options.input) {
        try {
          inputs = JSON.parse(options.input);
        } catch (err) {
          throw new Error('failed to parse --input JSON', { cause: err });
        }
      } else {
        inputs = {};
      }

      const runner = new Runner(cg, opts);
      const result = await runner.run(undefined, inputs);
      console.log(JSON.stringify(result.toData(), null, 2));
    },
  );
