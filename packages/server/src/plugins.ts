import { loadRemotePlugin, PluginRegistry, type PluginCapability } from '@heddle/core';
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
/**
 * What a submitted plugin may be granted here.
 *
 * Written out rather than derived from `PLUGIN_CAPABILITIES`, so that a
 * capability added to heddle is not granted to callers' plugins by the act of
 * upgrading.
 *
 * `runTool` is on the list because it reaches nothing a caller could not
 * already reach by other means: a plugin's tool calls resolve against the same
 * merged registry a `ToolNode` does — see `buildRegistry` in runs.ts — so a
 * caller who can submit a plugin can equally submit a flow naming the same
 * tool. It is *not* limited to the tools that caller submitted. `--tools-dir`
 * is in that registry too, and a plugin can name any executable in it, with
 * input of its own choosing and without the flow mentioning it: the reverse
 * call is checked against the registry, never against the spec.
 *
 * What that asks of an operator: under `--allow-request-code`, `--tools-dir`
 * *is* the set of tools you are offering your callers. An executable in it that
 * you would not hand a caller directly does not belong there — plugins or no
 * plugins. If you must keep one there, drop `runTool` from this list and accept
 * that guardrails cannot consult a tool.
 */
const GRANTED: PluginCapability[] = ['runTool'];

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
          // Per call, not per run. This used to pass the run's whole
          // wall-clock budget, so a plugin call had no independent bound at
          // all. See ServerConfig.pluginCallTimeout.
          //
          // Clamped to the run budget because nothing else enforces it. A
          // pending plugin call is not interruptible: `Runner._run` looks at
          // the run's signal between nodes, `PluginHost.call` takes no signal,
          // so `await executor.execute(...)` sits there until the plugin's own
          // timer fires. Whichever of the two is larger is therefore the real
          // bound on how long a concurrency slot is held — and an operator who
          // lowered `--timeout` to shed load would otherwise have raised it.
          timeout: Math.min(config.pluginCallTimeout, config.timeout),
          // Nothing. Not a filtered subset of the server's environment — none
          // of it. A plugin that needs configuration takes it from its own
          // spec fields, which the caller wrote and can see.
          //
          // Under --safe the plugin is not left with a literally empty
          // environment: the sandbox supplies its own base — PATH, HOME,
          // TMPDIR, PWD, HEDDLE_WORKSPACE, HEDDLE_SANDBOX — all synthesized,
          // and none of them the server's.
          env: {},
          capabilities: GRANTED,
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
