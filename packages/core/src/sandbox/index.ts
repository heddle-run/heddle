import { spawnSync } from 'node:child_process';
import { BubblewrapSandbox } from './bubblewrap.js';
import { SeatbeltSandbox } from './seatbelt.js';
import { SandboxError } from '../errors.js';
import type { Sandbox, SandboxPolicy } from './types.js';

export type SandboxBackend = 'auto' | 'bubblewrap' | 'seatbelt';

export type {
  Sandbox,
  SandboxSession,
  SandboxPolicy,
  SandboxCommand,
} from './types.js';
export { DEFAULT_SANDBOX_POLICY } from './types.js';
export { BubblewrapSandbox } from './bubblewrap.js';
export { SeatbeltSandbox } from './seatbelt.js';

export function createSandbox(
  backend: SandboxBackend,
  policy: SandboxPolicy,
): Sandbox {
  switch (backend) {
    case 'bubblewrap':
      return bubblewrap(policy);
    case 'seatbelt':
      return seatbelt(policy);
    case 'auto':
      return nativeSandbox(policy);
    default:
      throw new SandboxError(`unknown sandbox backend "${backend}"`);
  }
}

function nativeSandbox(policy: SandboxPolicy): Sandbox {
  if (process.platform === 'linux') return bubblewrap(policy);
  if (process.platform === 'darwin') return seatbelt(policy);

  throw new SandboxError(
    `--safe is not supported on ${process.platform}; ` +
      'sandboxing requires Linux (bubblewrap) or macOS (seatbelt).',
  );
}

function bubblewrap(policy: SandboxPolicy): Sandbox {
  if (process.platform !== 'linux') {
    throw new SandboxError(
      `--sandbox bubblewrap requires Linux (running on ${process.platform})`,
    );
  }

  const bwrapPath = findBwrap();
  if (!bwrapPath) {
    throw new SandboxError(
      'bubblewrap not found on PATH. Install it with your package manager ' +
        '(e.g. "apt install bubblewrap" or "dnf install bubblewrap").',
    );
  }

  return new BubblewrapSandbox(policy, bwrapPath);
}

function seatbelt(policy: SandboxPolicy): Sandbox {
  if (process.platform !== 'darwin') {
    throw new SandboxError(
      `--sandbox seatbelt requires macOS (running on ${process.platform})`,
    );
  }
  return new SeatbeltSandbox(policy);
}

function findBwrap(): string | undefined {
  const probe = spawnSync('bwrap', ['--version'], { stdio: 'ignore' });
  return probe.error ? undefined : 'bwrap';
}
