import type { CompiledGraph } from './types.js';
import { CompileError } from '../errors.js';

export function validate(graph: CompiledGraph): void {
  const reachable = reachableFromStart(graph);

  const problems = [
    ...missingStart(graph),
    ...unreachableNodes(graph, reachable),
    ...missingReachableEnd(graph, reachable),
    ...deadEndNodes(graph, reachable),
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
