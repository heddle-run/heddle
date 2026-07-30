#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createSandbox, type Sandbox, type SandboxBackend } from '@heddle/core';
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
  --work-dir <dir>       Where per-run directories are created (default: $TMPDIR)
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
      'max-iterations': { type: 'string' },
      timeout: { type: 'string' },
      'plugin-timeout': { type: 'string' },
      'max-concurrent': { type: 'string' },
      'drain-timeout': { type: 'string' },
      'cors-origin': { type: 'string', multiple: true },
      'allow-request-code': { type: 'boolean' },
      'work-dir': { type: 'string' },
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

  const started = await startServer({
    host: values.host,
    port: toInt(values.port, '--port'),
    toolsDir,
    flowsRoot: values['flows-root'],
    maxIterations: toInt(values['max-iterations'], '--max-iterations'),
    timeout: toInt(values.timeout, '--timeout'),
    pluginCallTimeout: toInt(values['plugin-timeout'], '--plugin-timeout'),
    maxConcurrentRuns: toInt(values['max-concurrent'], '--max-concurrent'),
    drainTimeout: toInt(values['drain-timeout'], '--drain-timeout'),
    corsOrigins: values['cors-origin'],
    allowRequestCode: values['allow-request-code'],
    workDir: values['work-dir'],
    defaultLlmKey: process.env.HEDDLE_LLM_DEFAULT_KEY || undefined,
    defaultLlmUrl: values['llm-default-url'],
    stream: boolEnv('HEDDLE_STREAM', process.env.HEDDLE_STREAM),
    sandbox: buildSandbox(values, toolsDir),
  });

  installShutdownHandlers(started);
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
    readPaths: [...(toolsDir ? [toolsDir] : []), ...allowRead],
    writePaths: allowWrite,
    network: !denyNet,
    passEnv: allowEnv,
  });
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
