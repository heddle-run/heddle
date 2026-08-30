import { compile } from './graph/compile.js';
import { validate } from './graph/validate.js';
import { loadFlow } from './spec/load.js';
import { collectToolNames, type ParsedFlow } from './spec/types.js';
import { loadPlugins } from './plugin/loader.js';
import { PluginRegistry } from './plugin/registry.js';
import { Runner } from './runner/runner.js';
import type { RunnerOptions } from './runner/options.js';
import type { EventHandler } from './runner/events.js';
import type { Dependencies } from './node/types.js';
import { State } from './state/state.js';
import { SubprocessExecutor } from './tool/executor.js';
import { createScratchWorkspace, workspaceTools } from './workspace/index.js';
import { assertToolsAvailable, standardRegistry } from './runenv.js';
import { assertRequirements, type Requirement } from './preflight.js';

export interface RunFlowOptions extends Partial<Omit<RunnerOptions, 'eventHandler'>> {
  /** A path to a flow document, or one already parsed with `loadFlow`. */
  flow: string | ParsedFlow;
  /** Directory of executables the flow's tools resolve against. */
  toolsDir?: string;
  /** What the start node's outputs are filled from. */
  inputs?: Record<string, unknown>;
  /**
   * Plugin specifiers to load for this run, or a registry already loaded.
   * Specifiers are loaded here and disposed when the run ends; a registry the
   * caller built stays the caller's to dispose.
   */
  plugins?: string[] | PluginRegistry;
  /**
   * What this machine must already have for the run to work — a bundle's
   * `requires`, or an embedder's own list. Checked before anything starts and
   * never acted on: heddle looks and reports, it does not install.
   */
  requires?: Requirement[];
  onEvent?: EventHandler;
  signal?: AbortSignal;
}

/**
 * Load, compile, validate and run a flow, in one call.
 *
 * The whole embedding ritual — `loadFlow`, plugin loading, registry assembly,
 * `compile`, `validate`, `Runner` — composed in the order the pieces expect,
 * for the caller whose need is "run this document and give me the state".
 * Anything from {@link RunnerOptions} can be set alongside; what is not takes
 * the same defaults the CLI uses.
 *
 * Deliberately not the whole surface. Sandboxing, persistent workspaces and
 * sessions are wiring decisions with flags and trade-offs of their own — a run
 * that needs them wants the CLI (`heddle run`) or the server, or the underlying
 * pieces this function is made of.
 *
 * ```ts
 * const state = await runFlow({
 *   flow: 'flow.json',
 *   toolsDir: 'tools',
 *   inputs: { query: 'hello' },
 * });
 * ```
 */
export async function runFlow(options: RunFlowOptions): Promise<State> {
  const {
    flow,
    toolsDir,
    inputs,
    plugins,
    requires,
    onEvent,
    signal,
    ...runnerOpts
  } = options;

  const loadedHere = Array.isArray(plugins);
  const registry = loadedHere
    ? await loadPlugins(plugins)
    : (plugins ?? PluginRegistry.empty());

  try {
    const parsed = typeof flow === 'string' ? loadFlow(flow, registry) : flow;

    const tools = standardRegistry({ plugins: registry, toolsDir });
    // Beside the tool check, and for the same reason it is here: both are the
    // machine failing to hold up its end, and both are cheaper to learn now
    // than at the node that reaches for the missing thing. Requirements first,
    // since "install ffmpeg" is the more useful of two messages a caller with
    // an empty machine would otherwise get one at a time.
    assertRequirements(requires ?? [], parsed.name);
    assertToolsAvailable(tools, collectToolNames(parsed));

    const deps: Dependencies = {
      toolExecutor: new SubprocessExecutor({ tools: workspaceTools(tools) }),
      toolRegistry: tools,
      plugins: registry,
      eventHandler: onEvent,
      middleware: runnerOpts.middleware,
      maxToolRounds: runnerOpts.maxToolRounds,
      scratchWorkspace: createScratchWorkspace,
    };

    const graph = compile(parsed, deps);
    validate(graph);

    return await new Runner(graph, {
      eventHandler: onEvent,
      ...runnerOpts,
    }).run(signal, inputs ?? {});
  } finally {
    if (loadedHere) registry.dispose();
  }
}
