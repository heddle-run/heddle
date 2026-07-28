import type { CompiledGraph } from './types.js';
import { CompileError } from '../errors.js';

/** Validate checks the compiled graph for structural issues. */
export function validate(g: CompiledGraph): void {
  const errs: string[] = [];

  if (!g.start) {
    errs.push('no start node');
  }

  // Check reachability from start
  const reachable = new Set<string>();
  const walk = (name: string): void => {
    if (reachable.has(name)) return;
    reachable.add(name);
    const cn = g.nodes.get(name);
    if (!cn) return;
    for (const edge of cn.edges) {
      walk(edge.toNode);
    }
  };
  walk(g.start);

  let hasReachableEnd = false;
  for (const [name, cn] of g.nodes) {
    if (!reachable.has(name)) {
      errs.push(`node "${name}" is unreachable from start`);
      continue;
    }
    if (cn.type === 'EndNode') {
      hasReachableEnd = true;
    } else if (cn.edges.length === 0) {
      // Anything that is not an end has somewhere to go next, or the run stops
      // in the middle of the graph.
      errs.push(`node "${name}" has no outgoing edges`);
    }
  }
  if (!hasReachableEnd) {
    errs.push('no reachable EndNode from start');
  }

  if (errs.length > 0) {
    throw new CompileError(errs.join('; '));
  }
}
