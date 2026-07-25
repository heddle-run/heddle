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

  // Check for orphan nodes (unreachable from start)
  for (const name of g.nodes.keys()) {
    if (!reachable.has(name)) {
      errs.push(`node "${name}" is unreachable from start`);
    }
  }

  // Check that at least one EndNode exists and is reachable
  let hasReachableEnd = false;
  for (const [name, cn] of g.nodes) {
    if (cn.type === 'EndNode' && reachable.has(name)) {
      hasReachableEnd = true;
      break;
    }
  }
  if (!hasReachableEnd) {
    errs.push('no reachable EndNode from start');
  }

  // Check that non-end nodes have outgoing edges
  for (const [name, cn] of g.nodes) {
    if (cn.type === 'EndNode') continue;
    if (!reachable.has(name)) continue;
    if (cn.edges.length === 0) {
      errs.push(`node "${name}" has no outgoing edges`);
    }
  }

  if (errs.length > 0) {
    throw new CompileError(errs.join('; '));
  }
}
