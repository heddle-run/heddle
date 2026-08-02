import {
  createSandbox,
  type Sandbox,
  type SandboxBackend,
} from './sandbox/index.js';
import {
  createWorkspaceFactory,
  parseMount,
  DEFAULT_MOUNT_MAX_BYTES,
  DEFAULT_MOUNT_MAX_ENTRIES,
  type Mount,
  type WorkspaceFactory,
} from './workspace/index.js';
import type { PluginRegistry } from './plugin/registry.js';
import { composeRegistries, FileRegistry, missingTools } from './tool/registry.js';
import type { Registry } from './tool/types.js';
import { SandboxError, ToolError } from './errors.js';

/**
 * The run environment, built the same way from either surface.
 *
 * The CLI and the server both take the same flags — a sandbox, the mounts, the
 * tools — and for a while each assembled them with its own copy of this file's
 * functions. The copies drifted in small ways nobody chose, which is the whole
 * argument for one: what `--safe` means should not depend on which binary
 * parsed it.
 */

export const SANDBOX_BACKENDS = new Set(['auto', 'bubblewrap', 'seatbelt']);
export const DEFAULT_SANDBOX_BACKEND = 'auto';

export interface SandboxOptions {
  safe?: boolean;
  sandbox?: string;
  allowRead: string[];
  allowWrite: string[];
  allowEnv: string[];
  denyNet?: boolean;
  /** Where workspaces are kept, when the operator named a directory. */
  workspace?: string;
}

export interface WorkspaceOptions {
  mount: string[];
  workspace?: string;
  mountMaxBytes?: string;
  mountMaxEntries?: string;
}

export function sandboxFromOptions(
  options: SandboxOptions,
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
    // A named workspace directory grants itself write. It is where the run's
    // tools are about to work, so making the operator also say --allow-write
    // for it would be heddle asking permission for the thing it was just told
    // to do.
    writePaths: [
      ...(options.workspace ? [options.workspace] : []),
      ...options.allowWrite,
    ],
    network: !options.denyNet,
    passEnv: options.allowEnv,
  });
}

export function assertNoSandboxTuning(options: SandboxOptions): void {
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

/**
 * What every node's workspace starts with, and where it lives.
 *
 * Not gated on `--safe`, unlike the flags above: a workspace exists on every
 * run, and where a run's files come from is not a question about confinement.
 * `--safe` decides only whether anything enforces the workspace's edges.
 */
export function workspacesFromOptions(
  options: WorkspaceOptions,
  plugins: PluginRegistry | undefined,
  onWarn: (message: string) => void,
  extraMounts: Mount[] = [],
): WorkspaceFactory {
  return createWorkspaceFactory({
    // The operator's first, so a collision reads as "your --mount and this
    // plugin want the same path" rather than the other way round — and a
    // bundle's before the plugins', because its origin names the file the
    // operator was handed rather than code nobody typed.
    mounts: [
      ...options.mount.map(parseMount),
      ...extraMounts,
      ...(plugins?.workspaceMounts() ?? []),
    ],
    root: options.workspace,
    budget: {
      maxBytes: positiveOption(
        '--mount-max-bytes',
        options.mountMaxBytes,
        DEFAULT_MOUNT_MAX_BYTES,
      ),
      maxEntries: positiveOption(
        '--mount-max-entries',
        options.mountMaxEntries,
        DEFAULT_MOUNT_MAX_ENTRIES,
      ),
    },
    onWarn,
  });
}

export function positiveOption(
  flag: string,
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new SandboxError(`${flag} must be a positive whole number, got "${raw}"`);
  }
  return value;
}

/**
 * The registry a run resolves its tools against: the plugins', then the
 * operator's directory, then whatever the caller layers on top — a directory
 * the request submitted, on a server that accepts one.
 */
export function standardRegistry(options: {
  plugins: PluginRegistry;
  /** The operator's tools directory — a path to scan, or one already scanned. */
  toolsDir?: string | Registry;
  extra?: Registry[];
}): Registry {
  const dir = options.toolsDir;

  return composeRegistries([
    options.plugins.toolRegistry(),
    typeof dir === 'object' ? dir : FileRegistry.create(dir ?? ''),
    ...(options.extra ?? []),
  ]);
}

export function assertToolsAvailable(registry: Registry, names: string[]): void {
  const missing = missingTools(registry, names);
  if (missing.length > 0) {
    throw new ToolError(`missing executables for tools: ${missing.join(', ')}`);
  }
}
