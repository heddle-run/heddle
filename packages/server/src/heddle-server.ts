#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  loadPlugins,
  parsePluginConfig,
  sandboxFromOptions,
  workspacesFromOptions,
  FileSessionStore,
  type PluginRegistry,
  type Sandbox,
  type SandboxOptions,
  type SessionStore,
  type WorkspaceOptions,
} from '@heddle/core';
import { storeFromPlugins } from './plugins.js';
import { startServer, VERSION, type StartedServer } from './server.js';
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
  --session-store <kind> Keep conversations across requests. "file" is the only
                         kind built in; any other name is a "store" component
                         from an installed plugin. Off by default — without it,
                         a request naming a session is refused and this server
                         stays stateless. Turning it on has two costs worth
                         choosing deliberately: conversations are written down,
                         and replicas backed by "file" do not share them
  --session-dir <dir>    Where the "file" store keeps sessions (default:
                         $HEDDLE_SESSION_DIR, then ~/.heddle/sessions)
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
  --no-mount-tools       Keep the tools out of the workspace, so the only way to
                         reach one is a call the model made. Costs a tool the
                         ability to run a peer; buys back the guarantee that
                         every tool call passes the toolCall seam, which is what
                         an installed approval gate is written against
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
  --version              Print the server version and exit
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

With --session-store on, a session id is a bearer capability: whoever holds one
can read and continue that conversation. Ids are issued by this server and are
random, and a request naming an id this server never issued is refused — but
that is unguessability, not authorization. Terminate authentication in front of
this if conversations are worth protecting.

--allow-request-code lets callers submit their own tool scripts and plugin
modules. Both run in their own processes, neither receives any of this process's
environment, and both stop when the run ends. A submitted spec cannot
dereference this process's environment either. One server can therefore serve
many concurrent untrusted runs.

What that option does not change: this server still executes computation its
callers choose and makes outbound requests to hosts they name. Restrict egress
and terminate authentication in front of it. See DEPLOYMENT.md.
`;

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
      'session-store': { type: 'string' },
      'session-dir': { type: 'string' },
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
      'no-mount-tools': { type: 'boolean' },
      'llm-default-url': { type: 'string' },
      safe: { type: 'boolean' },
      sandbox: { type: 'string' },
      'allow-read': { type: 'string', multiple: true },
      'allow-write': { type: 'string', multiple: true },
      'allow-env': { type: 'string', multiple: true },
      'deny-net': { type: 'boolean' },
      version: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const toolsDir = values['tools-dir'];
  const log = (message: string): void => {
    process.stderr.write(`${message}\n`);
  };
  // The flags the CLI also takes, in the one shape core's helpers read — so
  // the casting parseArgs forces happens here once rather than per field.
  const runEnv: SandboxOptions & WorkspaceOptions = {
    safe: values.safe,
    sandbox: values.sandbox,
    allowRead: values['allow-read'] ?? [],
    allowWrite: values['allow-write'] ?? [],
    allowEnv: values['allow-env'] ?? [],
    denyNet: values['deny-net'],
    workspace: values.workspace,
    mount: values.mount ?? [],
    mountMaxBytes: values['mount-max-bytes'],
    mountMaxEntries: values['mount-max-entries'],
  };
  const sandbox = sandboxFromOptions(runEnv, toolsDir, pluginDirs(values.plugin));
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

  const pluginConfig = parsePluginConfig(values['plugin-config']);
  let sessions: { store: SessionStore; name: string } | undefined;
  try {
    sessions = buildSessionStore(
      values['session-store'],
      values['session-dir'],
      plugins,
      pluginConfig,
    );
  } catch (err) {
    // The same reasoning as the catch below: a store that will not build is a
    // server that never starts, and the plugin processes discovery may already
    // have spawned are this function's to stop.
    plugins?.dispose();
    throw err;
  }

  let started: StartedServer;
  try {
    started = await startServer({
      host: values.host,
      sessionStore: sessions?.store,
      sessionStoreName: sessions?.name,
      port: toInt(values.port, '--port'),
      toolsDir,
      flowsRoot: values['flows-root'],
      plugins,
      pluginConfig,
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
      workspaces: workspacesFromOptions(runEnv, plugins, log),
      mountTools: values['no-mount-tools'] !== true,
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

const FILE_STORE = 'file';

/**
 * Where this server keeps conversations, if it keeps any.
 *
 * `file` is built in. Any other name is a `store` component an installed plugin
 * provides, which is how a deployment with more than one replica gets a store
 * they share — the file store is per-machine, and two pods backed by it hold
 * two different sets of conversations under the same ids.
 */
function buildSessionStore(
  kind: string | undefined,
  dir: string | undefined,
  plugins: PluginRegistry | undefined,
  pluginConfig: Record<string, Record<string, unknown>>,
): { store: SessionStore; name: string } | undefined {
  if (kind === undefined) {
    if (dir !== undefined) {
      throw new Error('--session-dir requires --session-store file');
    }
    return undefined;
  }

  if (kind === FILE_STORE) {
    return { store: new FileSessionStore({ root: dir }), name: FILE_STORE };
  }

  if (dir !== undefined) {
    throw new Error(
      `--session-dir is a setting of the built-in "${FILE_STORE}" store, and ` +
        `this server was asked for "${kind}". A plugin store is configured ` +
        `with --plugin-config ${kind}=<json>.`,
    );
  }

  const store = storeFromPlugins(plugins, kind, pluginConfig);
  if (!store) {
    throw new Error(
      `--session-store "${kind}" names no store. Built in: "${FILE_STORE}". ` +
        `Anything else is a component with "kind": "store" from a plugin, ` +
        `which has to be installed with --plugin as well as named here.`,
    );
  }

  return { store, name: kind };
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
