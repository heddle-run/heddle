import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HeddlePlugin } from './types.js';
import { PluginRegistry } from './registry.js';
import { discoverTools, loadRemotePlugin, readManifest } from './remote-loader.js';
import type { PluginManifest } from './manifest.js';
import { PLUGIN_CAPABILITIES, type PluginCapability } from './protocol.js';
import type { Sandbox } from '../sandbox/types.js';
import { createScratchWorkspace } from '../workspace/index.js';
import { PluginError } from '../errors.js';

const MANIFEST_EXTENSION = '.json';
const ENTRY_POINT_EXTENSIONS = ['.mjs', '.js'];

export async function loadPlugin(specifier: string): Promise<HeddlePlugin> {
  const plugin = await importPlugin(specifier);

  if (!plugin || typeof plugin !== 'object') {
    throw new PluginError(
      `plugin "${specifier}" must default-export a plugin object`,
    );
  }
  if (typeof plugin.name !== 'string' || !plugin.name) {
    throw new PluginError(`plugin "${specifier}" is missing a "name"`);
  }
  if (declaredComponentCount(plugin) === 0) {
    throw new PluginError(
      `plugin "${specifier}" declares no nodes, transforms, components or tools`,
    );
  }

  return plugin;
}

export interface LoadPluginsOptions {
  /**
   * Whether the operator allowed a plugin to be *started* so heddle can ask what
   * tools it has.
   *
   * Off by default, and a manifest asking for it is refused rather than ignored
   * — see `assertDiscoveryAllowed`. Reading a manifest executes nothing, which is
   * what makes `heddle validate` free and lets a spec be inspected without
   * running its author's code. Discovery spends that, so it is the operator's to
   * spend and not the plugin author's.
   */
  discovery?: boolean;
  /**
   * Whether these processes will serve more than one run.
   *
   * False on the CLI, where a load and a run are the same thing. True on a
   * server, which starts its installed plugins once and reaches them from every
   * request. See `PluginHostOptions.shared` for what the host stops doing.
   */
  shared?: boolean;
  /** Budget for a single call into one of these plugins. */
  timeout?: number;
  /** Confines each plugin to its own session, if the caller has a backend. */
  sandbox?: Sandbox;
  /**
   * Where a plugin's own stderr goes, for a host that has somewhere to put it.
   *
   * Required in practice by `shared`, and separate from it because they are
   * separate facts: one is about how many runs the process serves, the other is
   * about whether this program keeps a log.
   */
  log?: (message: string) => void;
}

export async function loadPlugins(
  specifiers: string[] | undefined,
  options: LoadPluginsOptions = {},
): Promise<PluginRegistry> {
  const registry = PluginRegistry.empty();
  const discovery = options.discovery ?? false;

  try {
    for (const specifier of specifiers ?? []) {
      if (specifier.endsWith(MANIFEST_EXTENSION)) {
        const path = resolve(process.cwd(), specifier);
        const raw = readManifest(path);
        assertDiscoveryAllowed(raw, specifier, discovery);

        const remote = remotePluginFrom(specifier, options);
        try {
          if (discovery) await discoverTools(remote, raw, dirname(path));
        } catch (err) {
          // This one is not in the registry yet — `addRemote` is below — so
          // nothing else has a reference to its process. Discovery is the first
          // thing on this path that starts one, and every way it can fail (a
          // bad tool name, an unknown componentType, the call timeout, a plugin
          // that never answers) would otherwise leave that process running with
          // no way left to stop it.
          remote.host.dispose();
          throw err;
        }
        registry.addRemote(remote);
      } else {
        registry.add(await loadPlugin(specifier));
      }
    }
  } catch (err) {
    // And these are: everything loaded before the one that failed. The same
    // disposition `buildPlugins` takes on the server — a partial registry is
    // torn down rather than returned or abandoned.
    registry.dispose();
    throw err;
  }

  return registry;
}

/**
 * Refuse a plugin that needs starting when nobody said it could be started.
 *
 * `checkGrant`'s shape, applied to the other thing an operator grants. A
 * manifest declaring `discoverTools` has said its tool list is unknowable
 * without running it, so loading it without the flag would leave a registry
 * missing every tool a flow is about to name — and the failure would surface
 * later as "missing executables for tools", pointing at the flow rather than at
 * the decision that caused it.
 */
function assertDiscoveryAllowed(
  manifest: PluginManifest,
  specifier: string,
  discovery: boolean,
): void {
  if (!manifest.discoverTools || discovery) return;
  throw new PluginError(
    `plugin "${manifest.name}" (${specifier}) declares "discoverTools", so heddle ` +
      `has to start it to learn what tools it provides. That is off by default: ` +
      `reading a manifest runs nothing, which is what lets a spec be checked ` +
      `without executing its author's code. Pass --discover-tools to allow it.`,
  );
}

async function importPlugin(specifier: string): Promise<HeddlePlugin> {
  let module: Record<string, unknown>;
  try {
    module = (await import(importTarget(specifier))) as Record<string, unknown>;
  } catch (err) {
    throw new PluginError(`failed to load plugin "${specifier}"`, {
      cause: err,
    });
  }
  return (module.default ?? module) as HeddlePlugin;
}

function importTarget(specifier: string): string {
  const isPath =
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    isAbsolute(specifier);

  return isPath
    ? pathToFileURL(resolve(process.cwd(), specifier)).href
    : specifier;
}

function declaredComponentCount(plugin: HeddlePlugin): number {
  return (
    (plugin.nodes?.length ?? 0) +
    (plugin.transforms?.length ?? 0) +
    (plugin.components?.length ?? 0) +
    (plugin.middleware?.length ?? 0) +
    (plugin.tools?.length ?? 0)
  );
}

function remotePluginFrom(specifier: string, options: LoadPluginsOptions) {
  const path = resolve(process.cwd(), specifier);
  const manifest = readManifest(path);

  const log = options.log;
  const label = `plugin-${manifest.name}`;
  const workspace = createScratchWorkspace(label);

  return loadRemotePlugin(manifest, entryFor(path), {
    root: dirname(path),
    capabilities: PLUGIN_CAPABILITIES,
    timeout: options.timeout,
    shared: options.shared,
    workspace,
    session: options.sandbox?.session(label, workspace),
    onStderr: log
      ? (chunk) => log(`plugin "${manifest.name}": ${chunk.trimEnd()}`)
      : undefined,
  });
}

function entryFor(manifestPath: string): string {
  const manifest = readManifest(manifestPath);
  if (manifest.command && manifest.command.length > 0) {
    return resolve(dirname(manifestPath), manifest.command[0]);
  }

  const base = manifestPath.slice(0, -MANIFEST_EXTENSION.length);
  for (const extension of ENTRY_POINT_EXTENSIONS) {
    if (existsSync(base + extension)) return base + extension;
  }

  throw new PluginError(
    `plugin manifest "${manifestPath}" names no "command" and there is no ` +
      `${base}.mjs or ${base}.js beside it, so heddle does not know what to run.`,
  );
}
