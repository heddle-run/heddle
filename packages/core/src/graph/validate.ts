import type { CompiledGraph, CompiledNode } from './types.js';
import type { AnyNode, BranchingNode } from '../spec/types.js';
import { propertyTitle, type Property } from '../spec/types.js';
import { isReservedStateKey, RESERVED_STATE_KEYS } from '../session/reserved.js';
import { CompileError } from '../errors.js';

const UNBRANCHED = '';

/** Where a BranchingNode sends a key its mapping does not name. */
const FALLBACK_BRANCH = 'default';

/**
 * Node types heddle writes the outputs of, whatever the spec declares.
 *
 * An LlmNode's executor returns `new State({ generated_text })` and nothing
 * else, so that is the whole set of keys a data flow edge can read from one. A
 * spec is free to declare `outputs` beside it; nothing fills them.
 *
 * No other node type belongs here. An AgentNode writes `result` plus whatever
 * keys its answer parsed to, a ToolNode writes what the tool returned, and a
 * plugin node writes what its plugin returned — none of those sets is knowable
 * from the document, so an edge reading one is not something to refuse.
 */
const CLOSED_OUTPUTS = new Map<string, string[]>([
  ['LlmNode', ['generated_text']],
]);

export function validate(graph: CompiledGraph): void {
  const reachable = reachableFromStart(graph);

  const problems = [
    ...missingStart(graph),
    ...unreachableNodes(graph, reachable),
    ...missingReachableEnd(graph, reachable),
    ...deadEndNodes(graph, reachable),
    ...unroutedMappings(graph),
    ...deadBranchEdges(graph),
    ...unproducibleInputs(graph),
    ...reservedStateKeys(graph),
  ];

  if (problems.length > 0) {
    throw new CompileError(problems.join('; '));
  }
}

function missingStart(graph: CompiledGraph): string[] {
  return graph.start ? [] : ['no start node'];
}

function unreachableNodes(
  graph: CompiledGraph,
  reachable: Set<string>,
): string[] {
  return [...graph.nodes.keys()]
    .filter((name) => !reachable.has(name))
    .map((name) => `node "${name}" is unreachable from start`);
}

function missingReachableEnd(
  graph: CompiledGraph,
  reachable: Set<string>,
): string[] {
  const hasEnd = [...graph.nodes].some(
    ([name, node]) => node.type === 'EndNode' && reachable.has(name),
  );
  return hasEnd ? [] : ['no reachable EndNode from start'];
}

function deadEndNodes(graph: CompiledGraph, reachable: Set<string>): string[] {
  return [...graph.nodes]
    .filter(
      ([name, node]) =>
        node.type !== 'EndNode' &&
        reachable.has(name) &&
        node.edges.length === 0,
    )
    .map(([name]) => `node "${name}" has no outgoing edges`);
}

/**
 * Branches a BranchingNode maps a key to and then cannot leave on.
 *
 * `mapping` is how the node answers and its control flow edges are how it
 * leaves; nothing in the document ties the two together, so a key can name a
 * branch no edge carries. The run reaches the node, selects that branch, and
 * stops there with `no next node from "<node>"` — a fault only the input that
 * selects the branch reveals, so a flow can pass every test it has and still
 * hold one.
 *
 * A node with an unbranched edge is left alone: `nextNode` falls back to that
 * edge for any branch it cannot match, so the run continues past it.
 */
function unroutedMappings(graph: CompiledGraph): string[] {
  const problems: string[] = [];

  for (const node of graph.nodes.values()) {
    const mapping = mappingOf(node);
    if (!mapping || hasUnbranchedEdge(node)) continue;

    const carried = branchesLeaving(node);
    for (const [key, branch] of Object.entries(mapping)) {
      if (carried.has(branch)) continue;
      problems.push(
        `BranchingNode "${node.name}" maps "${key}" to branch "${branch}", ` +
          `but no control flow edge leaves the node on it — a run that ` +
          `selects "${key}" ends with 'no next node from "${node.name}"'`,
      );
    }
  }

  return problems;
}

/**
 * Edges labelled with a branch their source node never selects.
 *
 * `nextNode` matches an outgoing edge against the branch the executor returned,
 * so an edge labelled with anything the node cannot return is a route that is
 * never taken. Where it is the node's only edge the run ends there; where it is
 * not, it is a path the flow's author believes in and the run will not use.
 *
 * A node that declares no branches is saying nothing here rather than saying it
 * has none, so it is left alone — the SDK's schema defaults `branches` to `[]`
 * and a hand-written spec routinely omits it.
 */
function deadBranchEdges(graph: CompiledGraph): string[] {
  const problems: string[] = [];

  for (const node of graph.nodes.values()) {
    const selectable = selectableBranches(node);
    if (!selectable) continue;

    for (const edge of node.edges) {
      const branch = edge.fromBranch ?? UNBRANCHED;
      if (branch === UNBRANCHED || selectable.has(branch)) continue;
      problems.push(
        `control flow edge from "${node.name}" to "${edge.toNode}" leaves on ` +
          `branch "${branch}", which "${node.name}" never selects ` +
          `(it selects ${[...selectable].join(', ')})`,
      );
    }
  }

  return problems;
}

/**
 * Data flow edges reading something their source node cannot produce.
 *
 * `Runner.resolveInputs` skips a mapping whose key is absent from the source
 * node's output, and says nothing: the destination never receives the input and
 * the run carries on around the hole. Both ways to write one are visible in the
 * document and neither is visible at run time — name a source node the flow
 * does not have, or read a key from a node whose outputs heddle fixes.
 */
function unproducibleInputs(graph: CompiledGraph): string[] {
  return graph.dataFlowEdges.flatMap((edge) => {
    const source = graph.nodes.get(edge.sourceNode);
    if (!source) {
      return [
        `data flow edge into "${edge.destinationNode}" reads from ` +
          `"${edge.sourceNode}", which is not a node in this flow`,
      ];
    }

    const produced = CLOSED_OUTPUTS.get(source.type);
    if (!produced || produced.includes(edge.sourceOutput)) return [];

    return [
      `data flow edge into "${edge.destinationNode}" reads output ` +
        `"${edge.sourceOutput}" from ${source.type} "${source.name}", which ` +
        `only produces ${produced.join(', ')} — the runner drops the mapping ` +
        `silently and "${edge.destinationInput}" never arrives`,
    ];
  });
}

/**
 * The branches a node's executor can return, or undefined where the document
 * does not say.
 *
 * A BranchingNode answers with a mapping value, or with the fallback for a key
 * its mapping does not name; it never reads its own `branches`, which is why
 * that is not what it is checked against. Every other node type is taken at its
 * word.
 */
/**
 * Refuse a flow that declares a name heddle puts in the state itself.
 *
 * `_chat_history` is written into a run's input by whoever supplies the
 * conversation, and read back out by every agent. A flow declaring an output by
 * the same name does not fail — it wins, or loses, depending on merge order in
 * `Runner.walk`, and the symptom is an agent that forgets the conversation on
 * some runs. Caught here so it is a validation error naming the node, which is
 * what `heddle validate` is for.
 */
function reservedStateKeys(graph: CompiledGraph): string[] {
  const problems: string[] = [];

  for (const node of graph.nodes.values()) {
    for (const [field, title] of declaredNames(node)) {
      if (!isReservedStateKey(title)) continue;
      problems.push(
        `node "${node.name}" declares ${field} "${title}", which heddle ` +
          `reserves for itself (reserved: ${RESERVED_STATE_KEYS.join(', ')})`,
      );
    }
  }

  return problems;
}

function declaredNames(node: CompiledNode): Array<[string, string]> {
  const spec = node.specNode as { inputs?: Property[]; outputs?: Property[] };

  return [
    ...titles('an input', spec.inputs),
    ...titles('an output', spec.outputs),
  ];
}

function titles(
  field: string,
  properties: Property[] | undefined,
): Array<[string, string]> {
  return (properties ?? []).map((property) => [field, propertyTitle(property)]);
}

function selectableBranches(node: CompiledNode): Set<string> | undefined {
  const mapping = mappingOf(node);
  if (mapping) {
    return new Set([...Object.values(mapping), FALLBACK_BRANCH]);
  }

  const declared = node.specNode.branches ?? [];
  return declared.length > 0 ? new Set(declared) : undefined;
}

function mappingOf(node: CompiledNode): Record<string, string> | undefined {
  const spec = node.specNode;
  return isBranching(spec) ? spec.mapping : undefined;
}

function isBranching(node: AnyNode): node is BranchingNode {
  return node.componentType === 'BranchingNode';
}

function branchesLeaving(node: CompiledNode): Set<string> {
  const branches = node.edges
    .map((edge) => edge.fromBranch ?? UNBRANCHED)
    .filter((branch) => branch !== UNBRANCHED);
  return new Set(branches);
}

function hasUnbranchedEdge(node: CompiledNode): boolean {
  return node.edges.some(
    (edge) => (edge.fromBranch ?? UNBRANCHED) === UNBRANCHED,
  );
}

function reachableFromStart(graph: CompiledGraph): Set<string> {
  const reachable = new Set<string>();
  const pending = [graph.start];

  while (pending.length > 0) {
    const name = pending.pop() as string;
    if (reachable.has(name)) continue;
    reachable.add(name);

    const node = graph.nodes.get(name);
    if (!node) continue;
    for (const edge of node.edges) {
      pending.push(edge.toNode);
    }
  }

  return reachable;
}
