/**
 * Loads plugin modules from disk.
 *
 * A plugin is an ES module whose default export is a HeddlePlugin. Plugins are
 * named on the command line or in project config — never inside a flow file, so
 * that sharing a spec can never cause code to be executed.
 */
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HeddlePlugin } from './types.js';
import { PluginRegistry } from './registry.js';
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
    (plugin.components?.length ?? 0);
  if (declared === 0) {
    throw new PluginError(
      `plugin "${specifier}" declares no nodes, transforms or components`,
    );
  }

  return plugin;
}

/** Loads every plugin and collects them into one registry. */
export async function loadPlugins(
  specifiers: string[] | undefined,
): Promise<PluginRegistry> {
  if (!specifiers || specifiers.length === 0) {
    return PluginRegistry.empty();
  }
  const plugins: HeddlePlugin[] = [];
  for (const specifier of specifiers) {
    plugins.push(await loadPlugin(specifier));
  }
  return PluginRegistry.fromPlugins(plugins);
}
