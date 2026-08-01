import {
  createScratchWorkspace,
  loadRemotePlugin,
  PluginRegistry,
  type PluginCapability,
} from '@heddle/core';
import type { ServerConfig } from './config.js';
import { HttpError } from './errors.js';
import type { MaterializedCode } from './request-code.js';

const GRANTED: PluginCapability[] = ['runTool', 'emitEvent', 'log'];

const NO_CALL_MODEL =
  'callModel is not granted on this server because it supplies a default model ' +
  'credential, and a submitted plugin can call the model as many times as it ' +
  'likes inside a single node — nothing in a flow shows how often. Run this ' +
  'plugin against a heddle started without HEDDLE_LLM_DEFAULT_KEY, where the ' +
  'only credential in play is the one your own spec brings.';

/**
 * Refuse a submitted plugin that has to be started before heddle knows what it
 * provides.
 *
 * `/v1/validate` proves something stronger than it looks: `loadRemotePlugin`
 * reads the manifest as data and `PluginHost` starts on first call, so
 * validating a flow executes none of the submitted plugin's code. Discovery
 * would spend exactly that, on the endpoint callers reach for *because* it runs
 * nothing — and it is the one route that takes no concurrency slot, so it would
 * become an unmetered way to make this server spawn processes.
 *
 * The operator cannot opt in on a caller's behalf here, because the caller and
 * the operator are different people. A dynamic tool list is something you
 * install, not something you accept in a request body.
 */
function refuseDiscovery(rawManifest: unknown): void {
  const manifest = rawManifest as { discoverTools?: unknown; name?: unknown };
  if (manifest?.discoverTools !== true) return;

  throw new HttpError(
    400,
    `this plugin declares "discoverTools", which cannot be submitted with a ` +
      `request. heddle would have to start it just to learn what tools it has, ` +
      `and this server reads a submitted manifest as data precisely so that ` +
      `validating a flow runs none of its author's code. Declare the tools in ` +
      `the manifest instead.`,
    'PluginError',
  );
}

/**
 * The registry one run resolves its components against.
 *
 * Two layers, and the order is the point. Underneath are the plugins the
 * operator installed, which every run sees and no run owns — disposing this
 * registry stops the ones this request brought and leaves those running. On top
 * are the request's own, which are refused if they claim a name the installed
 * layer already provides: a caller cannot redefine a component type the
 * operator's flows resolve by declaring it again.
 */
export function buildPlugins(
  config: ServerConfig,
  code: MaterializedCode,
): PluginRegistry {
  const registry = config.plugins?.extend() ?? PluginRegistry.empty();
  if (code.plugins.length === 0) return registry;

  const capabilities = grantedBy(config);

  try {
    for (const plugin of code.plugins) {
      refuseShadowing(plugin.manifest);
      refuseMiddleware(plugin.manifest);
      refuseDiscovery(plugin.manifest);

      const label = `plugin-${plugin.name}`;
      const workspace = createScratchWorkspace(label);

      registry.addRemote(
        loadRemotePlugin(plugin.manifest, plugin.path, {
          timeout: Math.min(config.pluginCallTimeout, config.timeout),
          env: {},
          capabilities,
          refusedBecause: { callModel: NO_CALL_MODEL },
          workspace,
          session: config.sandbox?.session(label, workspace),
        }),
      );
    }
  } catch (err) {
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

function grantedBy(config: ServerConfig): PluginCapability[] {
  return config.defaultLlmKey ? GRANTED : [...GRANTED, 'callModel'];
}

function refuseMiddleware(rawManifest: unknown): void {
  const manifest = rawManifest as {
    components?: Array<{ kind?: string; componentType?: string }>;
  };
  const middleware = (manifest?.components ?? []).filter(
    (component) => component?.kind === 'middleware',
  );
  if (middleware.length === 0) return;

  const names = middleware
    .map((component) => `"${component.componentType}"`)
    .join(', ');

  throw new HttpError(
    400,
    `this plugin declares middleware (${names}), which cannot be submitted with a ` +
      `request. Middleware runs on ` +
      `every node of every flow, so it is installed by whoever runs this server ` +
      `— with --plugin, at startup — rather than chosen per request. A component ` +
      `your own flow selects is a node, a transform or a provider; a rendering ` +
      `your own client selects is an encoder, which you may submit.`,
    'PluginError',
  );
}

function refuseShadowing(rawManifest: unknown): void {
  if (typeof rawManifest !== 'object' || rawManifest === null) return;

  const tools = (rawManifest as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return;

  for (const tool of tools) {
    if (typeof tool !== 'object' || tool === null) continue;

    const entry = tool as { name?: unknown; shadows?: unknown };
    if (entry.shadows !== true) continue;

    throw new HttpError(
      400,
      `tool "${String(entry.name)}" declares "shadows", which this server does not ` +
        `accept from a submitted plugin. Shadowing lets a manifest take a tool name ` +
        `something else already provides, and a name bound that way can be reached ` +
        `by code the submitter did not write. Choose a name nothing else uses.`,
      'PluginError',
    );
  }
}
