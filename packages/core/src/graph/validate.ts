import type { CompiledGraph } from './types.js';
import { CompileError } from '../errors.js';

/**
 * Check a compiled graph holds the invariants the runner leans on.
 *
 * Almost everything that used to live here is now unrepresentable — the graph
 * is derived from a steps list rather than transcribed from edge lists, so
 * dangling edges, unrouted branches and duplicate names cannot be written.
 * What is left is a backstop over the derivation itself: every node reachable,
 * a terminal reachable, no node stranded without a way out. A fault here is a
 * bug in heddle's lowering, not in the document — `resolve.ts` is where a
 * document's own faults are caught, before compilation.
 */
export function validate(graph: CompiledGraph): void {
  const reachable = reachableFromStart(graph);

  const problems = [
    ...missingStart(graph),
    ...unreachableNodes(graph, reachable),
    ...missingReachableTerminal(graph, reachable),
    ...deadEndNodes(graph, reachable),
  ];

  if (problems.length > 0) {
    throw new CompileError(problems.join('; '));
  }
}

function missingStart(graph: CompiledGraph): string[] {
  return graph.getNode(graph.start) ? [] : ['no start node'];
}

function unreachableNodes(
  graph: CompiledGraph,
  reachable: Set<string>,
): string[] {
  return [...graph.nodes.keys()]
    .filter((name) => !reachable.has(name))
    .map((name) => `node "${name}" is unreachable from start`);
}

function missingReachableTerminal(
  graph: CompiledGraph,
  reachable: Set<string>,
): string[] {
  const hasTerminal = [...graph.nodes.values()].some(
    (node) => graph.isTerminal(node) && reachable.has(node.name),
  );
  return hasTerminal ? [] : ['no reachable outcome from start'];
}

function deadEndNodes(graph: CompiledGraph, reachable: Set<string>): string[] {
  return [...graph.nodes.values()]
    .filter(
      (node) =>
        !graph.isTerminal(node) &&
        reachable.has(node.name) &&
        node.edges.length === 0,
    )
    .map((node) => `node "${node.name}" has no outgoing edges`);
}

function reachableFromStart(graph: CompiledGraph): Set<string> {
  const reachable = new Set<string>();
  const pending = [graph.start];

  while (pending.length > 0) {
    const name = pending.pop() as string;
    if (reachable.has(name)) continue;
    reachable.add(name);

    const node = graph.getNode(name);
    if (!node) continue;
    for (const edge of node.edges) {
      pending.push(edge.to);
    }
  }

  return reachable;
}
