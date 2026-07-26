/**
 * Loads a plugin that runs in its own process.
 *
 * The contrast with `loader.ts` is the whole point of this design. That one
 * `import()`s a module, which executes it: by the time heddle knows what the
 * plugin provides, the plugin has already run inside the server. Here nothing
 * is executed to find that out — the manifest is read as data, and the
 * plugin's process is not started until a node using it actually runs.
 *
 * What comes back is an ordinary {@link HeddlePlugin}, so `PluginRegistry`,
 * the deserializer and `compile()` treat it exactly like an in-process one.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { SandboxSession } from '../sandbox/types.js';
import { PluginError } from '../errors.js';
import { PluginHost, type PluginHostOptions } from './host.js';
import { validateManifest, type PluginManifest } from './manifest.js';
import { remoteComponentDef, remoteNodeDef, remoteTransformDef } from './remote.js';
import type { HeddlePlugin } from './types.js';

export interface RemotePluginOptions {
  /** Wall-clock budget for a single call into the plugin. */
  timeout?: number;
  /** Confines the plugin process, as a sandbox would confine a tool. */
  session?: SandboxSession;
  /**
   * Environment for the plugin process. Empty by default — a plugin sees no
   * variable it was not explicitly given, which is the property the in-process
   * API could not offer at any price.
   */
  env?: Record<string, string>;
}

/** A loaded out-of-process plugin, and the process behind it. */
export interface RemotePlugin {
  plugin: HeddlePlugin;
  host: PluginHost;
}

/**
 * How to start a plugin whose manifest does not say.
 *
 * A `.mjs` or `.js` entry runs under the same node that is running heddle,
 * which is the common case and saves every plugin author a `command`. Anything
 * else must be executable and carry its own shebang — the same contract a tool
 * has.
 */
function defaultCommand(entry: string): string[] {
  if (entry.endsWith('.mjs') || entry.endsWith('.js')) {
    return [process.execPath, entry];
  }

  let mode: number;
  try {
    mode = statSync(entry).mode;
  } catch (err) {
    throw new PluginError(`plugin entry point "${entry}" is not accessible`, { cause: err });
  }
  if ((mode & 0o111) === 0) {
    throw new PluginError(
      `plugin entry point "${entry}" is not executable and is not a .mjs/.js file. ` +
        `Either make it executable with a shebang, or set "command" in the manifest.`,
    );
  }
  return [entry];
}

/**
 * Build a plugin from a manifest and an entry point.
 *
 * `manifest` is taken as unparsed data rather than a path so the same function
 * serves a plugin on disk and one that arrived in a request body.
 */
export function loadRemotePlugin(
  rawManifest: unknown,
  entryPath: string,
  options: RemotePluginOptions = {},
): RemotePlugin {
  const manifest = validateManifest(rawManifest);
  const entry = isAbsolute(entryPath) ? entryPath : resolve(process.cwd(), entryPath);

  const command = manifest.command
    ? // Resolved against the plugin's own directory, so a manifest can name a
      // helper shipped beside it without knowing where it was installed.
      manifest.command.map((part, i) =>
        i === 0 && !isAbsolute(part) && part.includes('/')
          ? resolve(dirname(entry), part)
          : part,
      )
    : defaultCommand(entry);

  const hostOptions: PluginHostOptions = {
    command,
    cwd: dirname(entry),
    timeout: options.timeout,
    session: options.session,
    env: options.env,
  };

  const host = new PluginHost(manifest.name, hostOptions);
  // A thunk rather than the host itself: the defs are built now, but nothing
  // should touch the process until a node actually executes.
  const getHost = (): PluginHost => host;

  const plugin: HeddlePlugin = {
    name: manifest.name,
    version: manifest.version,
    nodes: [],
    transforms: [],
    components: [],
  };

  for (const entryComponent of manifest.components) {
    switch (entryComponent.kind ?? 'node') {
      case 'node':
        plugin.nodes!.push(remoteNodeDef(manifest, entryComponent, getHost));
        break;
      case 'transform':
        plugin.transforms!.push(remoteTransformDef(manifest, entryComponent, getHost));
        break;
      case 'component':
        plugin.components!.push(remoteComponentDef(entryComponent));
        break;
    }
  }

  return { plugin, host };
}

/** Read a manifest from disk. Data only — nothing is executed. */
export function readManifest(path: string): PluginManifest {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new PluginError(`plugin manifest "${path}" is not readable`, { cause: err });
  }
  try {
    return validateManifest(JSON.parse(raw));
  } catch (err) {
    if (err instanceof PluginError) throw err;
    throw new PluginError(`plugin manifest "${path}" is not valid JSON`, { cause: err });
  }
}
