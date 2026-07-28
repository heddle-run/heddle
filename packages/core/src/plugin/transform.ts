/**
 * Runs the MessageTransform chain attached to an agent.
 *
 * Agent Spec puts transforms on `Agent.transforms`, so they travel with the agent
 * rather than with a flow's graph. That is what lets a guardrail apply in chat
 * mode and to a standalone agent, not just inside a flow.
 */
import type { Dependencies } from '../node/types.js';
import type { TransformSpec } from '../spec/types.js';
import type {
  PluginComponent,
  PluginReporter,
  PluginTransformExecutor,
  TransformPhase,
} from './types.js';
import type { Message } from '../llm/types.js';
import { pluginReporter } from './executor.js';
import { PluginModel, toolRunner, type ToolRunner } from './services.js';
import { PluginError } from '../errors.js';

/** Transforms the SDK defines but heddle does not execute yet. */
const BUILTIN_TRANSFORMS = new Set([
  'MessageSummarizationTransform',
  'ConversationSummarizationTransform',
]);

const VALID_ACTIONS = new Set(['pass', 'modify', 'reject']);

export interface TransformOutcome {
  messages: Message[];
  /** Set when a transform refused. The caller decides what to do about it. */
  rejected?: {
    reason: string;
    transform: string;
    phase: TransformPhase;
    /**
     * Text the transform wants returned in place of the model's answer. Absent
     * when it supplied no replacement, in which case the reason stands in.
     */
    replacement?: string;
  };
}

interface Entry {
  component: PluginComponent;
  impl: PluginTransformExecutor;
  /**
   * Built once, at compile time, rather than per application. It closes over
   * the agent name, which `apply` is not given and should not have to be — the
   * chain already knows which agent it belongs to.
   */
  reporter: PluginReporter;
  /**
   * The two verbs a transform shares with a node, built here for the same
   * reason the reporter is: they close over the dependencies, which `apply` is
   * not given.
   *
   * A transform reached these out of process and not in it, which is how a
   * guardrail that consults a classifier worked from the playground and failed
   * from `heddle run --plugin`. The capability is the plugin's, so it cannot
   * depend on which side of the process boundary the component runs on.
   */
  runTool: ToolRunner;
  model: PluginModel;
  phases: Set<TransformPhase>;
}

/**
 * The transform chain for one agent. Built at compile time so a misconfigured
 * transform fails before the flow starts rather than mid-run.
 */
export class TransformChain {
  private entries: Entry[];

  private constructor(entries: Entry[]) {
    this.entries = entries;
  }

  /** An empty chain — the common case, and free to apply. */
  static empty(): TransformChain {
    return new TransformChain([]);
  }

  static build(
    transforms: TransformSpec[] | undefined,
    deps: Dependencies,
    agentName: string,
  ): TransformChain {
    if (!transforms || transforms.length === 0) {
      return TransformChain.empty();
    }

    const entries: Entry[] = [];
    for (const spec of transforms) {
      const def = deps.plugins?.transformDef(spec.componentType);
      if (!def) {
        if (BUILTIN_TRANSFORMS.has(spec.componentType)) {
          // Dropping one silently would quietly change an agent's context
          // handling, so it is reported even though it is not fatal. The engine
          // does not print; the consumer decides how to surface this.
          deps.eventHandler?.({
            type: 'warning',
            nodeName: agentName,
            message:
              `agent "${agentName}" declares ${spec.componentType} ` +
              `"${spec.name}", which heddle does not implement yet — skipping.`,
          });
          continue;
        }
        throw new PluginError(
          `agent "${agentName}": transform "${spec.name}" has type ` +
            `"${spec.componentType}", which no plugin provides.\n` +
            `  Loaded plugins: ${deps.plugins?.describe() ?? 'none'}`,
        );
      }

      const component = spec as unknown as PluginComponent;
      const phase = def.phase?.(component) ?? 'pre';
      const where = `${spec.componentType} "${spec.name}"`;
      entries.push({
        component,
        impl: def.createTransform(component, deps),
        runTool: toolRunner(where, deps),
        model: new PluginModel(where, component, deps),
        // Attributed to the agent, not to the transform's own name: a transform
        // is not a node, and the agent is the only position in the graph a
        // consumer can hang its events off. Which transform spoke is in
        // `nodeType`, and in the event type itself.
        reporter: pluginReporter(deps.eventHandler, {
          nodeName: agentName,
          componentType: spec.componentType,
        }),
        phases:
          phase === 'both'
            ? new Set<TransformPhase>(['pre', 'post'])
            : new Set<TransformPhase>([phase]),
      });
    }

    return new TransformChain(entries);
  }

  /** True when the agent has no transforms at all. */
  isEmpty(): boolean {
    return this.entries.length === 0;
  }

  /**
   * Whether anything runs in this phase.
   *
   * Asked before a model call, not after: a `post` transform can reject an
   * answer, and an answer cannot be un-sent. See the streaming decision in
   * `node/agent.ts`.
   */
  hasPhase(phase: TransformPhase): boolean {
    return this.entries.some((entry) => entry.phases.has(phase));
  }

  /**
   * Applies every transform for this phase in order, stopping at the first
   * rejection.
   */
  async apply(
    phase: TransformPhase,
    messages: Message[],
    signal: AbortSignal | undefined,
  ): Promise<TransformOutcome> {
    let current = messages;

    for (const entry of this.entries) {
      if (!entry.phases.has(phase)) continue;

      const result = await entry.impl.apply(current, {
        signal,
        phase,
        component: entry.component,
        runTool: entry.runTool,
        callModel: entry.model.bind(signal),
        ...entry.reporter,
      });

      if (!result || !VALID_ACTIONS.has(result.action)) {
        throw new PluginError(
          `transform "${entry.component.name}" returned an invalid action ` +
            `"${result?.action}" (expected pass, modify or reject)`,
        );
      }

      if (result.action === 'reject') {
        const reason = result.reason ?? 'rejected';
        return {
          messages: result.messages ?? current,
          rejected: {
            reason,
            transform: entry.component.name,
            phase,
            replacement: result.messages?.at(-1)?.content,
          },
        };
      }

      if (result.action === 'modify') {
        if (!Array.isArray(result.messages)) {
          throw new PluginError(
            `transform "${entry.component.name}" returned "modify" without a ` +
              `"messages" array`,
          );
        }
        current = result.messages;
      }
    }

    return { messages: current };
  }
}
