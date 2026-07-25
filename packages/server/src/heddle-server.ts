#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { startServer } from './server.js';
import { DEFAULT_HOST, DEFAULT_PORT } from './config.js';

const USAGE = `Usage: heddle-server [options]

Serves the heddle execution engine over HTTP.

Options:
  --host <host>        Interface to bind (default: ${DEFAULT_HOST})
  --port <port>        Port to listen on (default: ${DEFAULT_PORT})
  --tools-dir <dir>    Directory of tool executables available to every run
  --flows-root <dir>   Root that "flowPath" requests are confined to
  --max-iterations <n> Maximum node executions per run
  --timeout <ms>       Wall-clock budget for a single run
  -h, --help           Show this message

SECURITY: there is no authentication. Every caller can execute the tools in
--tools-dir. The default bind address is loopback; overriding --host exposes an
unauthenticated remote-code-execution surface.
`;

function toInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${flag} must be a non-negative integer, got "${value}"`);
  }
  return n;
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
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  const started = await startServer({
    host: values.host,
    port: toInt(values.port, '--port'),
    toolsDir: values['tools-dir'],
    flowsRoot: values['flows-root'],
    maxIterations: toInt(values['max-iterations'], '--max-iterations'),
    timeout: toInt(values.timeout, '--timeout'),
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
