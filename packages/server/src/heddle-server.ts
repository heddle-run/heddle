#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createSandbox, type Sandbox, type SandboxBackend } from '@heddle/core';
import { startServer } from './server.js';
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_MAX_CONCURRENT_RUNS,
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
  --max-concurrent <n>   Runs allowed at once (default: ${DEFAULT_MAX_CONCURRENT_RUNS})
  --cors-origin <origin> Browser origin allowed to call this server (repeatable,
                         or "*" for any)
  --allow-request-code   Accept tool scripts and plugin modules in the request
  --work-dir <dir>       Where per-run directories are created (default: $TMPDIR)
  --safe                 Run tool subprocesses inside an OS sandbox
  --sandbox <backend>    Sandbox backend: auto, bubblewrap, seatbelt (needs --safe)
  --allow-read <path>    Grant sandboxed tools read access to a path (repeatable)
  --allow-write <path>   Grant sandboxed tools write access to a path (repeatable)
  --allow-env <name>     Forward an environment variable into the sandbox (repeatable)
  --deny-net             Block network access for sandboxed tools
  -h, --help             Show this message

SECURITY: there is no authentication. Every caller can execute the tools in
--tools-dir. The default bind address is loopback; overriding --host exposes an
unauthenticated remote-code-execution surface.

--allow-request-code goes further: callers submit their own tool scripts and
plugin modules. Plugin modules are imported into this Node process and run with
its environment and its filesystem access; --safe confines tool subprocesses and
does nothing about plugins. Use that option only where the process itself is the
sandbox — one disposable container per run.
`;

function toInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${flag} must be a non-negative integer, got "${value}"`);
  }
  return n;
}

const SANDBOX_BACKENDS = new Set(['auto', 'bubblewrap', 'seatbelt']);

/**
 * Build the sandbox, or undefined when --safe was not given.
 *
 * The --allow-* and --deny-net flags only shape a sandbox, so using one without
 * --safe is a mistake worth reporting rather than ignoring — silently running
 * unconfined after being asked to restrict something is the wrong failure.
 */
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
    const tuning = [
      backend !== undefined && '--sandbox',
      allowRead.length > 0 && '--allow-read',
      allowWrite.length > 0 && '--allow-write',
      allowEnv.length > 0 && '--allow-env',
      denyNet && '--deny-net',
    ].filter((f): f is string => typeof f === 'string');

    if (tuning.length > 0) {
      throw new Error(`${tuning.join(', ')} requires --safe`);
    }
    return undefined;
  }

  const chosen = backend ?? 'auto';
  if (!SANDBOX_BACKENDS.has(chosen)) {
    throw new Error(
      `unknown sandbox backend "${chosen}" (expected ${[...SANDBOX_BACKENDS].join(', ')})`,
    );
  }

  return createSandbox(chosen as SandboxBackend, {
    // Read-only: a tool can be run, but cannot rewrite itself or its siblings.
    readPaths: [...(toolsDir ? [toolsDir] : []), ...allowRead],
    writePaths: allowWrite,
    network: !denyNet,
    passEnv: allowEnv,
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      host: { type: 'string' },
      port: { type: 'string' },
      'tools-dir': { type: 'string' },
      'flows-root': { type: 'string' },
      'max-iterations': { type: 'string' },
      timeout: { type: 'string' },
      'max-concurrent': { type: 'string' },
      'cors-origin': { type: 'string', multiple: true },
      'allow-request-code': { type: 'boolean' },
      'work-dir': { type: 'string' },
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
    maxConcurrentRuns: toInt(values['max-concurrent'], '--max-concurrent'),
    corsOrigins: values['cors-origin'],
    allowRequestCode: values['allow-request-code'],
    workDir: values['work-dir'],
    // Built before the listener so a bad sandbox setup fails at startup rather
    // than on the first request that would have been confined by it.
    sandbox: buildSandbox(values, toolsDir),
  });

  const shutdown = (): void => {
    void started.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
