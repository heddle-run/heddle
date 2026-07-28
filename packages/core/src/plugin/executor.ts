/**
 * Adapts a plugin's executor to heddle's internal NodeExecutor interface, and
 * builds the reporting context every plugin — node or transform — is handed.
 *
 * Plugin authors work with plain objects — input in, `{ output, branch }` out —
 * so a plugin module never has to import heddle's State class or match its
 * two-call execute/branch protocol.
 */
import { State } from '../state/state.js';
import type { Dependencies, NodeExecutor } from '../node/types.js';
import type { EventHandler } from '../runner/events.js';
import { pluginEventType } from '../runner/events.js';
import type { ExecutorScope } from '../tool/types.js';
import { runRegisteredTool } from '../tool/run.js';
import { createWorkspace, removeDir } from '../sandbox/workspace.js';
import type {
  PluginContext,
  PluginNode,
  PluginNodeDef,
  PluginReporter,
} from './types.js';
import { PluginError } from '../errors.js';

/** Which component an event came from, and which graph node it happened under. */
export interface EventSource {
  /**
   * The node whose execution this event belongs to. For a transform that is
   * the agent it hangs off, since a transform is not a node and the agent is
   * the only position in the graph a consumer can attribute it to.
   */
  nodeName: string;
  componentType: string;
}

/**
 * Refuse a payload that cannot survive the trip to a client.
 *
 * `data` is whatever the plugin passed, and the server writes it into an SSE
 * frame with `JSON.stringify`. A circular object or a BigInt in there throws
 * inside the event handler, on the runner's own stack, which fails the run —
 * and with it every other observer of that run — over one plugin's malformed
 * progress report. Caught here it is the plugin's own call that fails, naming
 * the event it was making.
 */
function assertSerializable(type: string, data: unknown): void {
  try {
    JSON.stringify(data);
  } catch (err) {
    throw new PluginError(
      `"${type}" was emitted with data that is not JSON: ${
        err instanceof Error ? err.message : String(err)
      }. An event's data is written straight into the client's stream, so it has ` +
        `to be plain values — no cycles, no BigInt, no class instances that ` +
        `stringify to nothing.`,
      { cause: err },
    );
  }
}

/**
 * Build the reporting half of a plugin's context.
 *
 * One implementation for both kinds, so a transform's events are attributed,
 * namespaced and validated exactly as a node's are. The alternative — each
 * caller assembling its own event — is how `nodeType` ends up meaning two
 * different things depending on which plugin emitted it.
 */
export function pluginReporter(
  handler: EventHandler | undefined,
  source: EventSource,
): PluginReporter {
  return {
    emitEvent(name: string, data?: unknown): void {
      // Both checks run before the handler is consulted, so a plugin's mistake
      // is its own failure whether or not anything happens to be listening —
      // otherwise a bad name would go unreported in every test that runs
      // without an event handler and surface for the first time in production.
      const type = pluginEventType(source.componentType, name);
      if (data !== undefined) assertSerializable(type, data);

      handler?.({
        type,
        nodeName: source.nodeName,
        nodeType: source.componentType,
        data,
      });
    },

    log(level, message): void {
      handler?.({
        type: 'plugin_log',
        nodeName: source.nodeName,
        nodeType: source.componentType,
        level,
        message,
      });
    },
  };
}

export class PluginNodeAdapter implements NodeExecutor {
  private node: PluginNode;
  private deps: Dependencies;
  private impl: ReturnType<PluginNodeDef['createExecutor']>;
  private declaredBranches: Set<string>;
  private _branch = '';
  /**
   * The directory this adapter made itself, because there was no sandbox to
   * take one from. Held for the length of one execution and cleared with it,
   * so a node visited twice by a loop gets two workspaces and never the stale
   * path of a directory that has already been removed.
   */
  private ownWorkspace?: string;

  constructor(node: PluginNode, def: PluginNodeDef, deps: Dependencies) {
    this.node = node;
    this.deps = deps;
    this.impl = def.createExecutor(node, deps);
    this.declaredBranches = new Set(node.branches ?? []);
  }

  branch(): string {
    return this._branch;
  }

  async execute(
    signal: AbortSignal | undefined,
    input: State,
  ): Promise<State> {
    // One sandbox session per node execution, matching AgentExecutor: the
    // tools a plugin node runs share a workspace with each other only.
    const scope = this.deps.toolExecutor?.beginScope?.(this.node.name);
    try {
      return await this.runNode(signal, input, scope);
    } finally {
      scope?.dispose();
      // Only the directory this adapter created. A sandbox session's workspace
      // belongs to the scope, which has just destroyed it, and removing it
      // again here would be a second delete of a path something else may by
      // then have reused.
      if (this.ownWorkspace !== undefined) {
        removeDir(this.ownWorkspace);
        this.ownWorkspace = undefined;
      }
    }
  }

  /**
   * The directory this execution writes to, made on demand.
   *
   * With a sandbox it is the scope's workspace: the one directory the tools
   * this node runs can see, which is what makes a path the plugin writes usable
   * as a `runTool` argument. Without a sandbox there is no such directory, so
   * one is created here — tools then run unconfined and can read it by absolute
   * path, so the plugin's code is the same either way and the sandboxed path
   * is not the only one a plugin author ever exercises.
   *
   * Deferred until asked, because most plugin nodes never touch a file and an
   * mkdtemp per node per run is a directory created and removed for nothing.
   */
  private workspace(scope: ExecutorScope | undefined): string {
    if (scope?.workspace !== undefined) return scope.workspace;
    this.ownWorkspace ??= createWorkspace(this.node.name);
    return this.ownWorkspace;
  }

  private async runNode(
    signal: AbortSignal | undefined,
    input: State,
    scope: ExecutorScope | undefined,
  ): Promise<State> {
    const ctx: PluginContext = {
      signal,
      node: this.node,
      runTool: (name, toolInput) =>
        runRegisteredTool(
          this.deps,
          { executor: scope?.executor, signal },
          name,
          toolInput,
          `${this.node.componentType} "${this.node.name}"`,
        ),
      getWorkspace: () => this.workspace(scope),
      ...pluginReporter(this.deps.eventHandler, {
        nodeName: this.node.name,
        componentType: this.node.componentType,
      }),
    };

    const result = await this.impl.execute(input.toData(), ctx);

    if (!result || typeof result !== 'object') {
      throw new PluginError(
        `${this.node.componentType} "${this.node.name}": executor must return ` +
          `{ output, branch? }, got ${typeof result}`,
      );
    }
    if (!result.output || typeof result.output !== 'object') {
      throw new PluginError(
        `${this.node.componentType} "${this.node.name}": executor returned no "output" object`,
      );
    }

    const branch = result.branch ?? '';
    if (branch && !this.declaredBranches.has(branch)) {
      // Caught here rather than at routing time, where the failure would surface
      // as a confusing "no next node" error.
      throw new PluginError(
        `${this.node.componentType} "${this.node.name}": executor returned branch ` +
          `"${branch}", which is not in its declared branches ` +
          `[${[...this.declaredBranches].join(', ')}]`,
      );
    }
    this._branch = branch;

    return new State(result.output);
  }
}
