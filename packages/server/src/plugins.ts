import { loadRemotePlugin, PluginRegistry } from '@heddle/core';
import type { ServerConfig } from './config.js';
import { HttpError } from './errors.js';
import type { MaterializedCode } from './request-code.js';

/**
 * Build the plugin registry for one run.
 *
 * Every submitted plugin is loaded out of process. That is not a hardening
 * option here, it is the only path this server offers: an in-process plugin is
 * imported into the server, and a caller who can do that has the server's
 * environment, its filesystem and its memory, whatever else is configured.
 *
 * Running them out of process is what makes it safe for one engine to serve
 * many concurrent runs — the property that removes the one-container-per-run
 * requirement. A plugin gets its own process, an empty environment, and is
 * killed when the run ends.
 */
export function buildPlugins(
  config: ServerConfig,
  code: MaterializedCode,
): PluginRegistry {
  const registry = PluginRegistry.empty();
  if (code.plugins.length === 0) return registry;

  try {
    for (const plugin of code.plugins) {
      registry.addRemote(
        loadRemotePlugin(plugin.manifest, plugin.path, {
          // A plugin call should not outlive the run that made it.
          timeout: config.timeout,
          // Nothing. Not a filtered subset of the server's environment — none
          // of it. A plugin that needs configuration takes it from its own
          // spec fields, which the caller wrote and can see.
          env: {},
          session: config.sandbox?.session(`plugin-${plugin.name}`),
        }),
      );
    }
  } catch (err) {
    // A plugin that fails to load is the caller's broken submission, so the
    // partial registry is torn down and reported as a bad request.
    registry.dispose();
    if (err instanceof HttpError) throw err;
    throw new HttpError(
      400,
      err instanceof Error ? err.message : String(err),
      'PluginError',
    );
  }

  return registry;
}
