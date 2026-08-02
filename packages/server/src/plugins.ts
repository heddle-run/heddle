import {
  createScratchWorkspace,
  messageOf,
  remotePlugin,
  PluginRegistry,
  SUBMITTABLE_KINDS,
  type ManifestComponent,
  type PluginManifest,
  type PluginMethod,
  type SessionStore,
} from '@heddle/core';
import type { ServerConfig } from './config.js';
import { HttpError } from './errors.js';
import type { MaterializedCode } from './request-code.js';

const GRANTED: PluginMethod[] = ['runTool', 'emitEvent', 'log'];

/**
 * The store an installed plugin provides under this component type.
 *
 * Only the operator's registry is consulted, never a request's. A store holds
 * every conversation this server has, so a caller that could name one could
 * name where everybody else's went — which is the same reasoning that keeps
 * middleware out of a request body.
 */
export function storeFromPlugins(
  plugins: PluginRegistry | undefined,
  componentType: string,
  config: Record<string, Record<string, unknown>> = {},
): SessionStore | undefined {
  return plugins?.createStore(componentType, config[componentType] ?? {});
}

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
function refuseDiscovery(manifest: PluginManifest): void {
  if (!manifest.discoverTools) return;

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
 *
 * A request that brought none gets the installed layer itself, not a copy —
 * which is why `handleRun` disposes only a registry it does not recognise.
 */
export function buildPlugins(
  config: ServerConfig,
  code: MaterializedCode,
): PluginRegistry {
  if (code.plugins.length === 0) {
    return config.plugins ?? PluginRegistry.empty();
  }

  const registry = config.plugins?.extend() ?? PluginRegistry.empty();
  const capabilities = grantedBy(config);

  try {
    for (const plugin of code.plugins) {
      refuseShadowing(plugin.manifest);
      refuseKind(plugin.manifest, 'middleware', middlewareRefusal);
      refuseKind(plugin.manifest, 'store', storeRefusal);
      refuseUnsubmittableKinds(plugin.manifest);
      refuseDiscovery(plugin.manifest);
      refuseWorkspaceFiles(plugin.manifest);

      const label = `plugin-${plugin.name}`;
      const workspace = createScratchWorkspace(label);

      registry.addRemote(
        remotePlugin(plugin.manifest, plugin.path, {
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
    throw new HttpError(400, messageOf(err), 'PluginError');
  }

  return registry;
}

function grantedBy(config: ServerConfig): PluginMethod[] {
  return config.defaultLlmKey ? GRANTED : [...GRANTED, 'callModel'];
}

/** The components of this kind, refused with the message the kind earns. */
function refuseKind(
  manifest: PluginManifest,
  kind: ManifestComponent['kind'],
  refusal: (names: string) => string,
): void {
  const declared = manifest.components.filter(
    (component) => component.kind === kind,
  );
  if (declared.length === 0) return;

  const names = declared
    .map((component) => `"${component.componentType}"`)
    .join(', ');

  throw new HttpError(400, refusal(names), 'PluginError');
}

function middlewareRefusal(names: string): string {
  return (
    `this plugin declares middleware (${names}), which cannot be submitted with a ` +
    `request. Middleware runs on ` +
    `every node of every flow, so it is installed by whoever runs this server ` +
    `— with --plugin, at startup — rather than chosen per request. A component ` +
    `your own flow selects is a node, a transform or a provider; a rendering ` +
    `your own client selects is an encoder, which you may submit.`
  );
}

/**
 * The refusal a submitted session store gets.
 *
 * The same rule as middleware, for a sharper reason. A store holds every
 * conversation this server has — one a caller supplied could read the lot, and
 * could be the destination for everybody else's. It is selected by name at
 * startup, so a submitted one would not even be reachable; refusing it says
 * why rather than letting it load and do nothing.
 */
function storeRefusal(names: string): string {
  return (
    `this plugin declares a session store (${names}), which cannot be ` +
    `submitted with a request. A store holds every conversation this server ` +
    `has, so it is installed by whoever runs it — with --plugin and ` +
    `--session-store, at startup — and never chosen per request.`
  );
}

/**
 * The backstop behind the named refusals above: anything not on the allowlist
 * is refused, so a kind this protocol grows later arrives here already closed
 * to requests rather than quietly open until somebody remembers this file.
 */
function refuseUnsubmittableKinds(manifest: PluginManifest): void {
  for (const component of manifest.components) {
    const kind = component.kind ?? 'node';
    if (SUBMITTABLE_KINDS.has(kind)) continue;

    throw new HttpError(
      400,
      `this plugin declares a ${kind} ("${component.componentType}"), which ` +
        `cannot be submitted with a request.`,
      'PluginError',
    );
  }
}

/**
 * A submitted plugin may not put files in the workspace.
 *
 * The shallow reason is that it could not work: a submitted plugin is
 * materialised from JSON — `request-code.ts` writes its source and nothing else
 * — so a "path" names a file that is not beside it, and every one of these
 * would fail to resolve.
 *
 * The real reason is why that is left as a refusal rather than fixed. `files`
 * puts bytes in the working directory of *every* node in the run, before the
 * flow starts and outside the toolCall seam. What a request may carry is code
 * that runs when something calls it. Content in everybody's working directory
 * is the operator's to decide, which is what `--mount` is for — and a caller
 * who wants files of their own has the request's own `files`, which are the
 * caller's own bytes on the caller's own budget.
 */
function refuseWorkspaceFiles(manifest: PluginManifest): void {
  if (manifest.files.length === 0) return;

  throw new HttpError(
    400,
    `this plugin declares "files", which cannot be submitted with a request. A ` +
      `plugin's files are read from the directory it was installed in, and a ` +
      `submitted plugin is a module with no directory — so there is nothing for ` +
      `them to resolve against. Send the content as this request's own "files", ` +
      `or ask whoever runs this server to mount it.`,
  );
}

function refuseShadowing(manifest: PluginManifest): void {
  for (const tool of manifest.tools) {
    if (tool.shadows !== true) continue;

    throw new HttpError(
      400,
      `tool "${tool.name}" declares "shadows", which this server does not ` +
        `accept from a submitted plugin. Shadowing lets a manifest take a tool name ` +
        `something else already provides, and a name bound that way can be reached ` +
        `by code the submitter did not write. Choose a name nothing else uses.`,
      'PluginError',
    );
  }
}
