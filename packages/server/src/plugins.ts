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
 *
 * `emitEvent` and `log` are on the list because of who is listening. A run's
 * events go to the SSE stream opened by the `POST` that started the run — see
 * `runStreaming` in runs.ts — and this server has no endpoint that attaches an
 * observer to somebody else's run. So under `--allow-request-code` the audience
 * of a submitted plugin's events is the caller who submitted it. That is not a
 * stranger putting text in front of your users; it is a caller writing to their
 * own client, on a stream whose contents they already choose by choosing the
 * flow.
 *
 * What makes that a grant rather than a shrug is that neither verb lets a
 * plugin be believed for something heddle said. The event type is minted by
 * heddle as `plugin:<componentType>:<name>` and the plugin supplies only the
 * last segment, so no submitted plugin can produce `flow_complete` and stop a
 * client early; the name has to be an identifier, and `SseStream.send` strips
 * CR/LF from it again at the wire, so it cannot carry a frame of its own; and
 * `log` arrives under heddle's own `plugin_log` type carrying the node it came
 * from, so a line is always attributable to the component that wrote it.
 *
 * What it does cost is volume. Neither verb is rate-limited or size-capped, so
 * a plugin in a loop can push bytes down its caller's stream and spend this
 * server's CPU doing it. The bound is the one every submitted flow already has
 * — the run's wall-clock budget and the plugin's per-call timeout — and the
 * cost lands on the connection incurring it. Note that reporting also *resets*
 * that per-call timeout, by design (`InFlight` in the protocol), so a plugin
 * that reports steadily is bounded by `--timeout` rather than by
 * `--plugin-call-timeout`.
 *
 * The assumption to check before keeping them: if you stream runs to a shared
 * operator console rather than back to the caller, the audience is not the
 * submitter any more and this reasoning does not hold. Drop both from this list.
 */
const GRANTED: PluginCapability[] = ['runTool', 'emitEvent', 'log'];

/**
 * Why `callModel` is withheld, when it is.
 *
 * A submitted plugin's model calls go to the `llm_config` on its own component,
 * so the *endpoint* is in the document the caller submitted and visible to
 * whoever reads it. What is not visible is the volume: `execute` is opaque by
 * construction, and a plugin is free to make a thousand calls inside one node
 * while the flow shows one. Nothing in the engine bounds that — `MAX_TOOL_ROUNDS`
 * bounds an agent's loop and has no equivalent here.
 *
 * That is survivable when the credential is the caller's own, and is not when
 * it is the operator's. `applyDefaultCredential` attaches `--default-llm-key`
 * to any config that names neither a key nor a URL, so a submitted component
 * writing `llm_config: { model_id: gpt-4o }` and looping spends the operator's
 * money at whatever rate it likes. So the capability goes away entirely the
 * moment there is an operator credential to spend, rather than being metered by
 * something this server does not have.
 *
 * The consequence, stated because it is a real loss: on a server configured
 * with a default key — which is what the playground is — an LLM-judge plugin
 * cannot be submitted at all, not even one bringing its own `api_key`. The
 * coarseness is the point; a per-component check would have to be right about
 * every path `createProvider` can take to the operator's key, and this one is
 * right by not having the key in play.
 */
const NO_CALL_MODEL =
  'callModel is not granted on this server because it supplies a default model ' +
  'credential, and a submitted plugin can call the model as many times as it ' +
  'likes inside a single node — nothing in a flow shows how often. Run this ' +
  'plugin against a heddle started without --default-llm-key, where the only ' +
  'credential in play is the one your own spec brings.';

/** What this server grants a submitted plugin, given how it is configured. */
function grantedBy(config: ServerConfig): PluginCapability[] {
  if (config.defaultLlmKey) return GRANTED;
  return [...GRANTED, 'callModel'];
}

/**
 * Refuse a submitted plugin that ships a middleware.
 *
 * Middleware is host-configured by design: it runs on every node of every flow,
 * whether that flow asked or not, which is precisely why it is the operator's
 * to install and not the caller's. A caller who could submit one would be
 * installing an error handler — or a retry loop, or a result substituter — on
 * runs whose specs say nothing about it.
 *
 * Refused rather than ignored, and refused here rather than left to fail at the
 * first node error. Silently dropping it would leave a caller believing their
 * retry policy was running; leaving it to load would leave them believing it
 * until something failed.
 */
function refuseMiddleware(rawManifest: unknown): void {
  const manifest = rawManifest as { components?: Array<{ kind?: string; componentType?: string }> };
  const middleware = (manifest?.components ?? []).filter((c) => c?.kind === 'middleware');
  if (middleware.length === 0) return;

  throw new HttpError(
    400,
    `this plugin declares middleware (${middleware
      .map((c) => `"${c.componentType}"`)
      .join(', ')}), which cannot be submitted with a request. Middleware runs on ` +
      `every node of every flow, so it is installed by whoever runs this server ` +
      `rather than chosen per request. A component your own flow selects is a node ` +
      `or a transform.`,
    'PluginError',
  );
}

export function buildPlugins(
  config: ServerConfig,
  code: MaterializedCode,
): PluginRegistry {
  const registry = PluginRegistry.empty();
  if (code.plugins.length === 0) return registry;

  const capabilities = grantedBy(config);

  try {
    for (const plugin of code.plugins) {
      refuseMiddleware(plugin.manifest);
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
          capabilities,
          refusedBecause: { callModel: NO_CALL_MODEL },
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
