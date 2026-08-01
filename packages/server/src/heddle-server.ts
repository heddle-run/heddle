#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  createSandbox,
  createWorkspaceFactory,
  loadPlugins,
  parseMount,
  parsePluginConfig,
  DEFAULT_MOUNT_MAX_BYTES,
  DEFAULT_MOUNT_MAX_ENTRIES,
  type PluginRegistry,
  type Sandbox,
  type SandboxBackend,
  type WorkspaceFactory,
} from '@heddle/core';
import { startServer, type StartedServer } from './server.js';
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_MAX_CONCURRENT_RUNS,
  DEFAULT_DRAIN_TIMEOUT,
  DEFAULT_PLUGIN_CALL_TIMEOUT,
  boolEnv,
} from './config.js';

const USAGE = `Usage: heddle-server [options]

Serves the heddle execution engine over HTTP.

Options:
  --host <host>          Interface to bind (default: ${DEFAULT_HOST})
  --port <port>          Port to listen on (default: ${DEFAULT_PORT})
  --tools-dir <dir>      Directory of tool executables available to every run
  --flows-root <dir>     Root that "flowPath" requests are confined to
  --plugin <path>        Install a plugin for every run: a manifest .json or a
                         JavaScript module (repeatable). This is the only way to
                         install middleware, which runs on every node of every
                         flow and so is never accepted in a request. One process
                         per plugin serves the whole server, so a plugin holding
                         a session or a pool keeps it warm across runs — and one
                         holding per-run state is holding it wrong
  --plugin-config <type=json>
                         Settings for an installed middleware, as
                         <ComponentType>=<json> or <ComponentType>=@file
                         (repeatable)
  --discover-tools       Let an installed plugin declaring "discoverTools" be
                         started so heddle can ask what tools it has. Off by
                         default: reading a manifest runs nothing. Never
                         available to a submitted plugin, whichever way this is
                         set
  --max-node-attempts <n> How many times one arrival at a node may be attempted
                         when installed middleware asks to retry it
  --max-iterations <n>   Maximum node executions per run
  --timeout <ms>         Wall-clock budget for a single run
  --plugin-timeout <ms>  Budget for a single call into a plugin process
                         (default: ${DEFAULT_PLUGIN_CALL_TIMEOUT}). Raise it only for a plugin
                         that legitimately blocks; a run may make many calls,
                         and each one holds a concurrency slot while it runs
  --max-concurrent <n>   Runs allowed at once (default: ${DEFAULT_MAX_CONCURRENT_RUNS})
  --drain-timeout <ms>   On SIGTERM, how long to let in-flight runs finish
                         (default: ${DEFAULT_DRAIN_TIMEOUT})
  --cors-origin <origin> Browser origin allowed to call this server (repeatable,
                         or "*" for any)
  --allow-request-code   Accept tool scripts and plugin modules in the request
  --allow-net <host>     Let a submitted spec reach this private host (repeatable)
  --work-dir <dir>       Where per-run directories are created (default: $TMPDIR)
  --mount <src[:dest][:ro|:rw]>
                         Put a file or directory in every workspace, for every
                         run. "ro" (the default) is a copy the run cannot carry
                         back; "rw" copies changed files out again when a node
                         finishes (repeatable). Operator-only: a request cannot
                         name a mount, for the same reason it cannot name a
                         sandbox
  --workspace <dir>      Keep each node's workspace under this directory instead
                         of a temporary one. Every run of every request writes
                         here, so this is a directory you are choosing to fill
  --mount-max-bytes <n>  Largest a --mount may be, in bytes
  --mount-max-entries <n> Most files and directories a --mount may hold
  --llm-default-url <url> Endpoint the default model credential belongs to. The
                         credential itself is read from HEDDLE_LLM_DEFAULT_KEY,
                         and is only ever used with this URL: a spec choosing
                         its own "url" must supply its own key.
  --safe                 Run tool subprocesses inside an OS sandbox
  --sandbox <backend>    Sandbox backend: auto, bubblewrap, seatbelt (needs --safe)
  --allow-read <path>    Grant sandboxed tools read access to a path (repeatable)
  --allow-write <path>   Grant sandboxed tools write access to a path (repeatable)
  --allow-env <name>     Forward an environment variable into the sandbox (repeatable)
  --deny-net             Block network access for sandboxed tools
  -h, --help             Show this message

Environment:
  HEDDLE_LLM_DEFAULT_KEY The default model credential. Read from the environment
                         rather than a flag so it stays out of "ps" output.
  HEDDLE_STREAM          Whether model calls stream (default: on). Set 0, false
                         or off for an endpoint that serves buffered requests
                         but not "stream: true", or that bills the two
                         differently. Accepted values: 1/0, true/false, on/off.

SECURITY: there is no authentication. Every caller can execute the tools in
--tools-dir. The default bind address is loopback; overriding --host exposes an
unauthenticated remote-code-execution surface.

--allow-request-code lets callers submit their own tool scripts and plugin
modules. Both run in their own processes, neither receives any of this process's
environment, and both stop when the run ends. A submitted spec cannot
dereference this process's environment either. One server can therefore serve
many concurrent untrusted runs.

What that option does not change: this server still executes computation its
callers choose and makes outbound requests to hosts they name. Restrict egress
and terminate authentication in front of it. See DEPLOYMENT.md.
`;

const SANDBOX_BACKENDS = new Set(['auto', 'bubblewrap', 'seatbelt']);
const DEFAULT_SANDBOX_BACKEND = 'auto';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      host: { type: 'string' },
      port: { type: 'string' },
      'tools-dir': { type: 'string' },
      'flows-root': { type: 'string' },
      plugin: { type: 'string', multiple: true },
      'plugin-config': { type: 'string', multiple: true },
      'discover-tools': { type: 'boolean' },
      'max-node-attempts': { type: 'string' },
      'max-iterations': { type: 'string' },
      timeout: { type: 'string' },
      'plugin-timeout': { type: 'string' },
      'max-concurrent': { type: 'string' },
      'drain-timeout': { type: 'string' },
      'cors-origin': { type: 'string', multiple: true },
      'allow-request-code': { type: 'boolean' },
      'allow-net': { type: 'string', multiple: true },
      'work-dir': { type: 'string' },
      mount: { type: 'string', multiple: true },
      workspace: { type: 'string' },
      'mount-max-bytes': { type: 'string' },
      'mount-max-entries': { type: 'string' },
      'llm-default-url': { type: 'string' },
      safe: { type: 'boolean' },
      sandbox: { type: 'string' },
      'allow-read': { type: 'string', multiple: true },
      'allow-write': { type: 'string', multiple: true },
      'allow-env': { type: 'string', multiple: true },
      'deny-net': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  const toolsDir = values['tools-dir'];
  const log = (message: string): void => {
    process.stderr.write(`${message}\n`);
  };
  const sandbox = buildSandbox(values, toolsDir, values.plugin);
  const pluginTimeout = toInt(values['plugin-timeout'], '--plugin-timeout');

  const plugins = await installPlugins(values.plugin, {
    discovery: values['discover-tools'] === true,
    // Resolved here rather than left undefined, so an installed plugin and a
    // submitted one get the budget the flag documents rather than each package's
    // own default. They agree today; nothing was making them.
    timeout: pluginTimeout ?? DEFAULT_PLUGIN_CALL_TIMEOUT,
    sandbox,
    log,
  });

  let started: StartedServer;
  try {
    started = await startServer({
      host: values.host,
      port: toInt(values.port, '--port'),
      toolsDir,
      flowsRoot: values['flows-root'],
      plugins,
      pluginConfig: parsePluginConfig(values['plugin-config']),
      maxNodeAttempts: toPositiveInt(
        values['max-node-attempts'],
        '--max-node-attempts',
      ),
      maxIterations: toInt(values['max-iterations'], '--max-iterations'),
      timeout: toInt(values.timeout, '--timeout'),
      pluginCallTimeout: pluginTimeout,
      maxConcurrentRuns: toInt(values['max-concurrent'], '--max-concurrent'),
      drainTimeout: toInt(values['drain-timeout'], '--drain-timeout'),
      corsOrigins: values['cors-origin'],
      allowRequestCode: values['allow-request-code'],
      allowNet: values['allow-net'],
      workDir: values['work-dir'],
      workspaces: buildWorkspaces(values, plugins),
      defaultLlmKey: process.env.HEDDLE_LLM_DEFAULT_KEY || undefined,
      defaultLlmUrl: values['llm-default-url'],
      stream: boolEnv('HEDDLE_STREAM', process.env.HEDDLE_STREAM),
      sandbox,
    });
  } catch (err) {
    // The server never started, so nothing it hands back will stop these. A bad
    // --plugin-config is the ordinary way to arrive here, and it arrives after
    // discovery has already spawned every plugin that asked for it.
    plugins?.dispose();
    throw err;
  }

  installShutdownHandlers(started);
}

/**
 * Load the plugins this server will serve every run from.
 *
 * Before the port is open, so an unreadable manifest, a missing entry point or a
 * component type two plugins both claim is a server that does not start. What
 * this does *not* prove is that the plugins run: a host spawns on its first
 * call, which is what keeps `/v1/validate` free. `--discover-tools` is the one
 * flag that spends it here, and it starts only the plugins that asked for it.
 */
async function installPlugins(
  specifiers: string[] | undefined,
  options: {
    discovery: boolean;
    timeout?: number;
    sandbox?: Sandbox;
    log: (message: string) => void;
  },
): Promise<PluginRegistry | undefined> {
  if (!specifiers || specifiers.length === 0) {
    if (options.discovery) {
      throw new Error('--discover-tools requires at least one --plugin');
    }
    return undefined;
  }

  return loadPlugins(specifiers, { ...options, shared: true });
}

function installShutdownHandlers(started: StartedServer): void {
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      process.stderr.write(
        `\nsecond ${signal}; closing open runs immediately\n`,
      );
      void started.close().then(exitFailure, exitFailure);
      return;
    }

    shuttingDown = true;
    void started.drain().then(exitSuccess, exitFailure);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function buildSandbox(
  values: Record<string, unknown>,
  toolsDir: string | undefined,
  pluginSpecifiers: string[] | undefined,
): Sandbox | undefined {
  const allowRead = (values['allow-read'] as string[] | undefined) ?? [];
  const allowWrite = (values['allow-write'] as string[] | undefined) ?? [];
  const allowEnv = (values['allow-env'] as string[] | undefined) ?? [];
  const backend = values.sandbox as string | undefined;
  const denyNet = Boolean(values['deny-net']);

  if (!values.safe) {
    assertNoSandboxTuning({ backend, allowRead, allowWrite, allowEnv, denyNet });
    return undefined;
  }

  const chosen = backend ?? DEFAULT_SANDBOX_BACKEND;
  if (!SANDBOX_BACKENDS.has(chosen)) {
    throw new Error(
      `unknown sandbox backend "${chosen}" (expected ${[...SANDBOX_BACKENDS].join(', ')})`,
    );
  }

  return createSandbox(chosen as SandboxBackend, {
    readPaths: [
      ...(toolsDir ? [toolsDir] : []),
      ...pluginDirs(pluginSpecifiers),
      ...allowRead,
    ],
    // A named workspace directory grants itself write: it is where the run's
    // tools are about to work, so making the operator also say --allow-write
    // for it would be heddle asking permission for what it was just told to do.
    writePaths: [
      ...(typeof values.workspace === 'string' ? [values.workspace] : []),
      ...allowWrite,
    ],
    network: !denyNet,
    passEnv: allowEnv,
  });
}

/**
 * What every node's workspace starts with, and where it lives.
 *
 * Fixed at startup, like confinement, and for the same reason: a request may
 * not choose what is in the working directory of every node of every run.
 * Unlike the sandbox flags it is not gated on `--safe` — a workspace exists
 * whether or not anything is enforcing its edges.
 */
function buildWorkspaces(
  values: Record<string, unknown>,
  plugins: PluginRegistry | undefined,
): WorkspaceFactory {
  return createWorkspaceFactory({
    // The operator's first, so a collision reads as "your --mount and this
    // plugin want the same path" rather than the other way round.
    mounts: [
      ...((values.mount as string[] | undefined) ?? []).map(parseMount),
      ...(plugins?.workspaceMounts() ?? []),
    ],
    root: values.workspace as string | undefined,
    budget: {
      maxBytes: positive(
        '--mount-max-bytes',
        values['mount-max-bytes'],
        DEFAULT_MOUNT_MAX_BYTES,
      ),
      maxEntries: positive(
        '--mount-max-entries',
        values['mount-max-entries'],
        DEFAULT_MOUNT_MAX_ENTRIES,
      ),
    },
    onWarn: (message) => process.stderr.write(`${message}\n`),
  });
}

function positive(flag: string, raw: unknown, fallback: number): number {
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive whole number, got "${String(raw)}"`);
  }
  return value;
}

/**
 * Each installed plugin's own directory.
 *
 * A confined plugin has to be able to read the program it *is*, and the sandbox
 * is built from flags rather than from anything the loader knows — so the paths
 * come from argv, before the manifests are read. Without this, `--safe` and
 * `--plugin` together produce a server that starts and then fails every call
 * into a plugin with EPERM opening its own entry point.
 *
 * The directory rather than the file, because a manifest sits beside the entry
 * point it names and a plugin may ship more than one file.
 */
function pluginDirs(specifiers: string[] | undefined): string[] {
  const dirs = new Set<string>();
  for (const specifier of specifiers ?? []) {
    dirs.add(dirname(resolve(process.cwd(), specifier)));
  }
  return [...dirs];
}

function assertNoSandboxTuning(tuning: {
  backend: string | undefined;
  allowRead: string[];
  allowWrite: string[];
  allowEnv: string[];
  denyNet: boolean;
}): void {
  const used = [
    tuning.backend !== undefined && '--sandbox',
    tuning.allowRead.length > 0 && '--allow-read',
    tuning.allowWrite.length > 0 && '--allow-write',
    tuning.allowEnv.length > 0 && '--allow-env',
    tuning.denyNet && '--deny-net',
  ].filter((flag): flag is string => typeof flag === 'string');

  if (used.length > 0) {
    throw new Error(`${used.join(', ')} requires --safe`);
  }
}

function toInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer, got "${value}"`);
  }
  return parsed;
}

/** For a count where zero means "never attempt it", which is not a setting. */
function toPositiveInt(
  value: string | undefined,
  flag: string,
): number | undefined {
  const parsed = toInt(value, flag);
  if (parsed !== undefined && parsed < 1) {
    throw new Error(`${flag} must be 1 or more, got "${value}"`);
  }
  return parsed;
}

function exitSuccess(): void {
  process.exit(0);
}

function exitFailure(): void {
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
