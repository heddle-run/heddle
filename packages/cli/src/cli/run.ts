import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
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
  composeRegistries,
  missingTools,
  PluginRegistry,
  MiddlewareChain,
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

/**
 * Read `--plugin-config ComponentType=<json>` into the shape the chain wants.
 *
 * `@file` is accepted alongside inline JSON for the same reason a server reads
 * a credential from a file: a command line is visible in `ps` and lands in a
 * shell history, and a middleware's configuration is as likely as not to hold
 * an endpoint or a key.
 *
 * Every failure here names the flag and what was wrong with it, because this is
 * an operator typing at a prompt — the one audience that can fix the problem in
 * the next five seconds if told precisely what it is.
 */
function parsePluginConfig(
  values: string[] | undefined,
): Record<string, Record<string, unknown>> {
  const config: Record<string, Record<string, unknown>> = {};

  for (const entry of values ?? []) {
    const eq = entry.indexOf('=');
    if (eq <= 0) {
      throw new Error(
        `--plugin-config expects <ComponentType>=<json>, got "${entry}". ` +
          `For example: --plugin-config RetryPolicy='{"maxAttempts":3}'`,
      );
    }
    const componentType = entry.slice(0, eq);
    const raw = entry.slice(eq + 1);

    let text = raw;
    if (raw.startsWith('@')) {
      const path = raw.slice(1);
      try {
        text = readFileSync(path, 'utf-8');
      } catch (err) {
        throw new Error(
          `--plugin-config ${componentType}=@${path}: the file is not readable ` +
            `(${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(
        `--plugin-config ${componentType}: the value is not JSON ` +
          `(${err instanceof Error ? err.message : String(err)})`,
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(
        `--plugin-config ${componentType}: expected a JSON object of settings, got ` +
          `${parsed === null ? 'null' : Array.isArray(parsed) ? 'an array' : typeof parsed}`,
      );
    }
    if (config[componentType]) {
      throw new Error(`--plugin-config was given twice for "${componentType}"`);
    }
    config[componentType] = parsed as Record<string, unknown>;
  }

  return config;
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
/**
 * Where a plugin's own tools live, so the sandbox can bind them.
 *
 * A plugin tool is an ordinary executable and gets the ordinary treatment —
 * `session.wrap` binds the program it is given. What it does not bind is
 * anything beside that program, so a script with a `#!/usr/bin/env python`
 * shebang, or one that reads a data file next to itself, needs its directory
 * readable. A tools directory has always been given that; a plugin's had
 * nowhere to be named until it could contribute tools.
 */
function pluginPaths(plugins: PluginRegistry): string[] {
  const dirs = new Set<string>();
  for (const tool of plugins.toolRegistry().all()) {
    if (tool.impl.kind === 'path') dirs.add(dirname(tool.impl.path));
  }
  return [...dirs];
}

function buildSandbox(
  options: SafeOptions,
  toolsDir: string | undefined,
  pluginDirs: string[] = [],
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
        pluginConfig?: string[];
        maxNodeAttempts?: string;
        stream?: boolean;
      } & SafeOptions,
      command: Command,
    ) => {
      const verbose = command.parent?.opts().verbose ?? false;

      // Plugins first, because a plugin can ship the executables its tools
      // name and the sandbox binds only what it is told about. Built the other
      // way round — as this was — a plugin tool with a `#!/usr/bin/env python`
      // shebang, or a data file beside the script, is outside the confined
      // filesystem and fails at first use, under --safe only.
      const plugins = await loadPlugins(options.plugin);
      let interactive = false;
      try {
        interactive = await runFlow(flowPath, options, plugins, verbose);
      } finally {
        // Every path, including the throwing ones. A `--plugin <manifest>.json`
        // now starts a real process, and this is the only thing that stops it:
        // the child holds a ref'd handle with piped stdio and its read loop
        // never sees stdin close, so without this `heddle run` prints its result
        // and then hangs. The server has always disposed in a `finally`; the CLI
        // had nothing to dispose until a manifest could be named here.
        //
        // Except in chat, which returns with its UI still running: the ink
        // app owns the process from now until the user quits, so disposing on
        // the way out of this function would stop every plugin before the first
        // message. Chat hands the same teardown to process exit instead.
        if (!interactive) plugins.dispose();
      }
    },
  );

function disposeOnExit(plugins: PluginRegistry): void {
  let done = false;
  const stop = (): void => {
    if (done) return;
    done = true;
    plugins.dispose();
  };
  process.on('exit', stop);
  // SIGINT is how a chat session actually ends, and it does not run `exit`
  // handlers on its own.
  process.on('SIGINT', () => {
    stop();
    process.exit(0);
  });
}

interface RunOptions extends SafeOptions {
  toolsDir?: string;
  input?: string;
  chat?: boolean;
  plugin?: string[];
  pluginConfig?: string[];
  maxNodeAttempts?: string;
  stream?: boolean;
}

/**
 * Everything between loading the plugins and the run's result.
 *
 * Extracted for one reason: whatever happens in here, the plugin processes have
 * to be stopped, and a `finally` around a hundred lines of inline action body
 * is a `finally` somebody adds a `return` above.
 */
async function runFlow(
  flowPath: string,
  options: RunOptions,
  plugins: PluginRegistry,
  verbose: boolean,
): Promise<boolean> {
      const pf = loadFlow(flowPath, plugins);

      const sandbox = buildSandbox(options, options.toolsDir, pluginPaths(plugins));
      if (sandbox && verbose) {
        console.error(
          `Sandbox: ${sandbox.name}, network ${options.denyNet ? 'denied' : 'allowed'}`,
        );
      }

      // The merged registry, not the directory alone. A flow naming a tool a
      // plugin provides used to be reported missing here — before the run that
      // would have found it — because this checked FileRegistry by itself.
      const reg = composeRegistries([
        plugins.toolRegistry(),
        FileRegistry.create(options.toolsDir ?? ''),
      ]);
      const toolNames = collectToolNames(pf);
      const missing = missingTools(reg, toolNames);
      if (missing.length > 0) {
        throw new Error(`missing executables for tools: ${missing.join(', ')}`);
      }

      const isChat = options.chat ?? false;
      const opts = buildRunnerOpts(verbose, isChat);

      if (options.maxNodeAttempts !== undefined) {
        const attempts = Number(options.maxNodeAttempts);
        if (!Number.isInteger(attempts) || attempts < 1) {
          throw new Error('--max-node-attempts must be a whole number of 1 or more');
        }
        opts.maxNodeAttempts = attempts;
      }

      const deps = {
        toolExecutor: new SubprocessExecutor({ sandbox }),
        toolRegistry: reg,
        plugins,
        eventHandler: (e: Event) => opts.eventHandler?.(e),
        // `--no-stream` is for an endpoint that cannot serve SSE, or bills a
        // streamed call differently. Commander leaves this true otherwise.
        stream: options.stream,
      };

      // Built here rather than inside compile, because a middleware is not part
      // of the graph: no document names one, and the same compiled flow run by
      // a different operator has a different chain. Building it before
      // `validate` keeps a misconfigured middleware a startup failure.
      opts.middleware = MiddlewareChain.build(
        plugins,
        deps,
        parsePluginConfig(options.pluginConfig),
      );
      if (verbose && !opts.middleware.isEmpty()) {
        console.error(`Middleware: ${opts.middleware.describe().join('; ')}`);
      }

      const cg = compile(pf, deps);
      validate(cg);

      if (isChat) {
        const { createSession } = await import('../chat/session.js');
        const { startChat } = await import('../chat/ui.js');
        const session = createSession(flowPath);
        const inputKey = detectInputKey(pf);

        console.error(`Conversation saved to: ~/.heddle/conversations/${session.id}.json`);
        disposeOnExit(plugins);
        startChat({ graph: cg, opts, session, inputKey });
        return true;
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
      return false;
}
