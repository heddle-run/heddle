import { INPUTS_NODE, type ParsedFlow, type Step } from '../spec/types.js';
import {
  flowEdges,
  refsOf,
  refsOfOutcome,
  pluginComponentOf,
  type SpecEdge,
} from '../spec/resolve.js';
import { refParts } from '../spec/template.js';
import type { Dependencies, NodeExecutor } from '../node/types.js';
import { PluginNodeAdapter } from '../plugin/executor.js';
import type { PluginNode } from '../plugin/types.js';
import { InputsExecutor, OutcomeExecutor } from '../node/boundary.js';
import { SwitchExecutor } from '../node/switch.js';
import { AgentExecutor } from '../node/agent.js';
import { LLMExecutor } from '../node/llm.js';
import { ToolStepExecutor } from '../node/tool.js';
import { UseStepExecutor } from '../node/use.js';
import { CompiledGraph, type CompiledNode, type DataSource } from './types.js';
import { CompileError } from '../errors.js';

/**
 * Turn a parsed flow into something a `Runner` can walk: every node paired
 * with the executor that will run it, every derived edge attached to its
 * source, every `{{ref}}` turned into the data mapping that will carry it.
 *
 * This is where `deps` is bound — the tool registry, the provider, the plugin
 * registry all reach a node's executor here, so a graph compiled against one
 * set of dependencies runs against that set for its whole life. Compiling is
 * cheap and starts nothing (no plugin process, no model call), which is why a
 * compiled graph can be built once and run many times.
 */
export function compile(flow: ParsedFlow, deps: Dependencies): CompiledGraph {
  const nodes = new Map<string, CompiledNode>();

  nodes.set(INPUTS_NODE, {
    name: INPUTS_NODE,
    type: 'start',
    spec: { role: 'inputs', inputs: flow.inputs },
    executor: new InputsExecutor(flow.inputs),
    edges: [],
    inputMappings: new Map(),
  });

  for (const step of flow.steps) {
    nodes.set(step.name, {
      name: step.name,
      type: step.kind === 'use' ? step.use : step.kind,
      spec: { role: 'step', step },
      executor: buildExecutor(step, deps),
      edges: [],
      inputMappings: mappingsOf(refsOf(step)),
    });
  }

  for (const outcome of flow.outcomes) {
    nodes.set(outcome.name, {
      name: outcome.name,
      type: 'outcome',
      spec: { role: 'outcome', outcome },
      executor: new OutcomeExecutor(outcome),
      edges: [],
      inputMappings: mappingsOf(refsOfOutcome(outcome)),
    });
  }

  attachEdges(flowEdges(flow), nodes);

  return new CompiledGraph(flow.name, nodes, INPUTS_NODE);
}

/**
 * A ref `a.b` resolves under its own dotted key, read from node `a`'s output
 * `b`. `inputs.x` reads the start node, whose output is the run's input.
 */
function mappingsOf(refs: string[]): Map<string, DataSource> {
  const mappings = new Map<string, DataSource>();
  for (const ref of refs) {
    const { source, key } = refParts(ref);
    mappings.set(ref, { sourceNode: source, sourceOutput: key });
  }
  return mappings;
}

function attachEdges(
  edges: SpecEdge[],
  nodes: Map<string, CompiledNode>,
): void {
  for (const edge of edges) {
    const source = nodes.get(edge.from);
    if (!source) {
      throw new CompileError(`edge from "${edge.from}" has no source node`);
    }
    source.edges.push(edge);
  }
}

function buildExecutor(step: Step, deps: Dependencies): NodeExecutor {
  switch (step.kind) {
    case 'agent':
      return new AgentExecutor(step, deps);
    case 'llm':
      return new LLMExecutor(step, deps);
    case 'tool':
      return new ToolStepExecutor(step, deps);
    case 'switch':
      return new SwitchExecutor(step);
    case 'use':
      return buildUseExecutor(step, deps);
  }
}

function buildUseExecutor(
  step: Step & { kind: 'use' },
  deps: Dependencies,
): NodeExecutor {
  const def = deps.plugins?.nodeDef(step.use);
  if (!def) {
    throw new CompileError(
      `step "${step.name}" uses "${step.use}", which no loaded plugin ` +
        `provides. Loaded plugins: ${deps.plugins?.describe() ?? 'none'}`,
    );
  }

  const node = pluginComponentOf(step.use, step.name, step.config) as PluginNode;
  node.branches = [];
  return new UseStepExecutor(
    step,
    new PluginNodeAdapter(node, def, deps),
  );
}
