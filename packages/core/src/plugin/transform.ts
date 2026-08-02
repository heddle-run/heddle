import type { Dependencies } from '../node/types.js';
import type { TransformSpec } from '../spec/types.js';
import type {
  PluginComponent,
  PluginReporter,
  PluginTransformDef,
  PluginTransformExecutor,
  TransformPhase,
  TransformResult,
} from './types.js';
import type { Message } from '../llm/types.js';
import { pluginReporter } from './executor.js';
import { PluginModel, toolRunner, type ToolRunner } from './services.js';
import { PluginError } from '../errors.js';

const UNIMPLEMENTED_BUILTIN_TRANSFORMS = new Set([
  'MessageSummarizationTransform',
  'ConversationSummarizationTransform',
]);

const VALID_ACTIONS = new Set(['pass', 'modify', 'reject']);

const DEFAULT_PHASE: TransformPhase = 'pre';

export interface TransformOutcome {
  messages: Message[];
  rejected?: {
    reason: string;
    transform: string;
    phase: TransformPhase;
    replacement?: string;
  };
}

interface Entry {
  component: PluginComponent;
  impl: PluginTransformExecutor;
  reporter: PluginReporter;
  runTool: ToolRunner;
  model: PluginModel;
  phases: Set<TransformPhase>;
}

export class TransformChain {
  private constructor(private readonly entries: Entry[]) {}

  static build(
    transforms: TransformSpec[] | undefined,
    deps: Dependencies,
    agentName: string,
  ): TransformChain {
    const entries: Entry[] = [];

    for (const spec of transforms ?? []) {
      const def = deps.plugins?.transformDef(spec.componentType);
      if (def) {
        entries.push(buildEntry(spec, def, deps, agentName));
        continue;
      }
      if (UNIMPLEMENTED_BUILTIN_TRANSFORMS.has(spec.componentType)) {
        warnSkipped(spec, deps, agentName);
        continue;
      }
      throw new PluginError(unknownTransformMessage(spec, deps, agentName));
    }

    return new TransformChain(entries);
  }

  isEmpty(): boolean {
    return this.entries.length === 0;
  }

  hasPhase(phase: TransformPhase): boolean {
    return this.entries.some((entry) => entry.phases.has(phase));
  }

  async apply(
    phase: TransformPhase,
    messages: Message[],
    signal: AbortSignal | undefined,
  ): Promise<TransformOutcome> {
    let current = messages;

    for (const entry of this.entries) {
      if (!entry.phases.has(phase)) continue;

      const result = await applyEntry(entry, phase, current, signal);

      if (result.action === 'reject') {
        return rejectionOutcome(entry, phase, result, current);
      }
      if (result.action === 'modify') {
        current = modifiedMessages(entry, result);
      }
    }

    return { messages: current };
  }
}

function buildEntry(
  spec: TransformSpec,
  def: PluginTransformDef,
  deps: Dependencies,
  agentName: string,
): Entry {
  const component = spec as unknown as PluginComponent;
  const where = `${spec.componentType} "${spec.name}"`;

  return {
    component,
    impl: def.createTransform(component, deps),
    runTool: toolRunner(where, deps),
    model: new PluginModel(where, component, deps),
    reporter: pluginReporter(deps.eventHandler, {
      nodeName: agentName,
      componentType: spec.componentType,
    }),
    phases: phasesOf(def, component),
  };
}

function phasesOf(
  def: PluginTransformDef,
  component: PluginComponent,
): Set<TransformPhase> {
  const phase = def.phase?.(component) ?? DEFAULT_PHASE;
  return phase === 'both'
    ? new Set<TransformPhase>(['pre', 'post'])
    : new Set<TransformPhase>([phase]);
}

async function applyEntry(
  entry: Entry,
  phase: TransformPhase,
  messages: Message[],
  signal: AbortSignal | undefined,
): Promise<TransformResult> {
  const result = await entry.impl.apply(messages, {
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
  return result;
}

function rejectionOutcome(
  entry: Entry,
  phase: TransformPhase,
  result: TransformResult,
  current: Message[],
): TransformOutcome {
  return {
    messages: result.messages ?? current,
    rejected: {
      reason: result.reason ?? 'rejected',
      transform: entry.component.name,
      phase,
      replacement: result.messages?.at(-1)?.content,
    },
  };
}

function modifiedMessages(entry: Entry, result: TransformResult): Message[] {
  if (!Array.isArray(result.messages)) {
    throw new PluginError(
      `transform "${entry.component.name}" returned "modify" without a ` +
        `"messages" array`,
    );
  }
  return result.messages;
}

function warnSkipped(
  spec: TransformSpec,
  deps: Dependencies,
  agentName: string,
): void {
  deps.eventHandler?.({
    type: 'warning',
    nodeName: agentName,
    message:
      `agent "${agentName}" declares ${spec.componentType} ` +
      `"${spec.name}", which heddle does not implement yet — skipping.`,
  });
}

function unknownTransformMessage(
  spec: TransformSpec,
  deps: Dependencies,
  agentName: string,
): string {
  return (
    `agent "${agentName}": transform "${spec.name}" has type ` +
    `"${spec.componentType}", which no plugin provides.\n` +
    `  Loaded plugins: ${deps.plugins?.describe() ?? 'none'}`
  );
}
