/**
 * Loads plugin modules from disk.
 *
 * A plugin is an ES module whose default export is a HeddlePlugin. Plugins are
 * named on the command line or in project config — never inside a flow file, so
 * that sharing a spec can never cause code to be executed.
 */
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HeddlePlugin } from './types.js';
import { PluginRegistry } from './registry.js';
import { loadRemotePlugin, readManifest } from './remote-loader.js';
import { PLUGIN_CAPABILITIES } from './protocol.js';
import { PluginError } from '../errors.js';

/**
 * Imports one plugin module. Bare specifiers (`heddle-plugin-foo`) resolve
 * through node's normal lookup; anything else is treated as a file path.
 */
export async function loadPlugin(specifier: string): Promise<HeddlePlugin> {
  const isPath =
    specifier.startsWith('.') || specifier.startsWith('/') || isAbsolute(specifier);
  const target = isPath
    ? pathToFileURL(resolve(process.cwd(), specifier)).href
    : specifier;

  let module: Record<string, unknown>;
  try {
    module = (await import(target)) as Record<string, unknown>;
  } catch (err) {
    throw new PluginError(`failed to load plugin "${specifier}"`, { cause: err });
  }

  const plugin = (module.default ?? module) as HeddlePlugin;
  if (!plugin || typeof plugin !== 'object') {
    throw new PluginError(
      `plugin "${specifier}" must default-export a plugin object`,
    );
  }
  if (typeof plugin.name !== 'string' || !plugin.name) {
    throw new PluginError(`plugin "${specifier}" is missing a "name"`);
  }
  const declared =
    (plugin.nodes?.length ?? 0) +
    (plugin.transforms?.length ?? 0) +
    (plugin.components?.length ?? 0) +
    (plugin.middleware?.length ?? 0) +
    (plugin.tools?.length ?? 0);
  if (declared === 0) {
    throw new PluginError(
      `plugin "${specifier}" declares no nodes, transforms, components or tools`,
    );
  }

  return plugin;
}

/**
 * Loads every plugin and collects them into one registry.
 *
 * Two shapes of specifier, told apart by extension. A `.json` is a manifest and
 * the plugin runs in its own process; anything else is an ES module imported
 * into this one. Both were already supported by heddle — but only the server
 * could reach the first, because `loadRemotePlugin` had no caller on this side.
 * A tool-source plugin is the case that made that gap matter: its whole content
 * is a manifest, so without this it could be submitted to a server and never
 * named on a command line.
 *
 * The distinction is not a hardening claim. An operator who types `--plugin`
 * has already chosen to run that code; what the manifest form buys here is the
 * form itself, plus the process boundary as a bonus rather than a barrier.
 */
export async function loadPlugins(
  specifiers: string[] | undefined,
): Promise<PluginRegistry> {
  if (!specifiers || specifiers.length === 0) {
    return PluginRegistry.empty();
  }

  const registry = PluginRegistry.empty();
  for (const specifier of specifiers) {
    if (specifier.endsWith('.json')) {
      const path = resolve(process.cwd(), specifier);
      registry.addRemote(
        loadRemotePlugin(readManifest(path), entryFor(path), {
          // The manifest's own directory, never the entry point's. A manifest
          // naming an interpreter — `["/usr/bin/python3", "server.py"]`, the
          // ordinary shape for a Python plugin — has an entry point that lives
          // nowhere near it.
          root: dirname(path),
          // Everything, because the operator named this plugin themselves. The
          // server's narrow grant exists because there a plugin arrives from a
          // caller; here the person granting and the person choosing are one.
          capabilities: PLUGIN_CAPABILITIES,
        }),
      );
      continue;
    }
    registry.add(await loadPlugin(specifier));
  }
  return registry;
}

/**
 * Which program a manifest starts.
 *
 * Only ever the *program*, never the plugin's root — those are two different
 * things and conflating them was a bug worth naming here. `loadRemotePlugin`
 * resolves `command`, the process cwd and every tool path against the root, so
 * a manifest saying `["/usr/bin/python3", "server.py"]` would have put all
 * three under `/usr/bin`: the plugin's own tools refused as "outside the plugin
 * directory", and any system binary admitted as inside it. The root is passed
 * separately, from the manifest's own location.
 *
 * The sibling search is for the case that has no `command` at all, where the
 * entry point and the root genuinely do coincide.
 */
function entryFor(manifestPath: string): string {
  const manifest = readManifest(manifestPath);
  if (manifest.command && manifest.command.length > 0) {
    return resolve(dirname(manifestPath), manifest.command[0]);
  }
  const base = manifestPath.replace(/\.json$/, '');
  for (const ext of ['.mjs', '.js']) {
    if (existsSync(base + ext)) return base + ext;
  }
  throw new PluginError(
    `plugin manifest "${manifestPath}" names no "command" and there is no ` +
      `${base}.mjs or ${base}.js beside it, so heddle does not know what to run.`,
  );
}
