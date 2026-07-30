import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HeddlePlugin } from './types.js';
import { PluginRegistry } from './registry.js';
import { discoverTools, loadRemotePlugin, readManifest } from './remote-loader.js';
import type { PluginManifest } from './manifest.js';
import { PLUGIN_CAPABILITIES } from './protocol.js';
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

export async function loadPlugins(
  specifiers: string[] | undefined,
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
  discovery = false,
): Promise<PluginRegistry> {
  const registry = PluginRegistry.empty();

  for (const specifier of specifiers ?? []) {
    if (specifier.endsWith(MANIFEST_EXTENSION)) {
      const path = resolve(process.cwd(), specifier);
      const raw = readManifest(path);
      assertDiscoveryAllowed(raw, specifier, discovery);

      const remote = remotePluginFrom(specifier);
      if (discovery) await discoverTools(remote, raw, dirname(path));
      registry.addRemote(remote);
    } else {
      registry.add(await loadPlugin(specifier));
    }
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

function remotePluginFrom(specifier: string) {
  const path = resolve(process.cwd(), specifier);
  return loadRemotePlugin(readManifest(path), entryFor(path), {
    root: dirname(path),
    capabilities: PLUGIN_CAPABILITIES,
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
