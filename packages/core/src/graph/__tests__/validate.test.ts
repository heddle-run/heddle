import { describe, it, expect } from 'vitest';
import { parseFlowObject } from '../../spec/parser.js';
import { compile } from '../compile.js';
import { validate } from '../validate.js';
import { CompiledGraph, type CompiledNode, type GraphNodeSpec } from '../types.js';
import type { SpecEdge } from '../../spec/resolve.js';
import type { State } from '../../state/state.js';

/**
 * One compiled node, with only the parts `validate` reads spelled out.
 *
 * The executor is a stub, because validation is a question about the derived
 * graph and never runs a node. A document can no longer express the faults
 * checked here — these graphs are built by hand precisely because they are
 * what a bug in the lowering would produce.
 */
function node(
  name: string,
  role: GraphNodeSpec['role'],
  edges: SpecEdge[] = [],
): CompiledNode {
  const spec: GraphNodeSpec =
    role === 'inputs'
      ? { role, inputs: {} }
      : role === 'outcome'
        ? { role, outcome: { name } }
        : {
            role,
            step: {
              kind: 'llm',
              name,
              model: { provider: 'openai', model: 'gpt-4o', extra: {} },
              prompt: 'hi',
            },
          };

  return {
    name,
    type: role === 'inputs' ? 'start' : role === 'outcome' ? 'outcome' : 'llm',
    spec,
    executor: {
      execute: async (_signal: AbortSignal | undefined, input: State) => input,
      branch: () => '',
    },
    edges,
    inputMappings: new Map(),
  };
}

function edge(from: string, to: string): SpecEdge {
  return { from, to };
}

/** A graph starting at the first node given. */
function graphOf(nodes: CompiledNode[]): CompiledGraph {
  return new CompiledGraph(
    'test',
    new Map(nodes.map((compiled) => [compiled.name, compiled])),
    nodes[0]!.name,
  );
}

describe('validate graph', () => {
  it('passes a graph compiled from a valid document', () => {
    const flow = parseFlowObject({
      weave: 1,
      name: 'ok',
      inputs: { q: 'string' },
      steps: [
        {
          name: 'draft',
          llm: {
            model: { provider: 'openai', model: 'gpt-4o' },
            prompt: 'hi {{inputs.q}}',
          },
        },
      ],
    });

    expect(() => validate(compile(flow, {}))).not.toThrow();
  });

  it('detects a node the derivation left unreachable', () => {
    const g = graphOf([
      node('inputs', 'inputs', [edge('inputs', 'end')]),
      node('end', 'outcome'),
      node('orphan', 'step'),
    ]);

    expect(() => validate(g)).toThrow(/"orphan" is unreachable from start/);
  });

  it('detects a reachable node with no way out', () => {
    const g = graphOf([
      node('inputs', 'inputs', [edge('inputs', 'stuck'), edge('inputs', 'end')]),
      node('stuck', 'step'),
      node('end', 'outcome'),
    ]);

    expect(() => validate(g)).toThrow(/"stuck" has no outgoing edges/);
  });

  it('detects a graph no outcome is reachable in', () => {
    const g = graphOf([
      node('inputs', 'inputs', [edge('inputs', 'spin')]),
      node('spin', 'step', [edge('spin', 'inputs')]),
    ]);

    expect(() => validate(g)).toThrow(/no reachable outcome from start/);
  });

  it('detects a missing start node', () => {
    const g = new CompiledGraph(
      'test',
      new Map([['end', node('end', 'outcome')]]),
      'inputs',
    );

    expect(() => validate(g)).toThrow(/no start node/);
  });
});
