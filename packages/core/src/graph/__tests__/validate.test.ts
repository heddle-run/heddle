import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFlow } from '../../spec/parser.js';
import { compile } from '../compile.js';
import { validate } from '../validate.js';
import { CompiledGraph, type CompiledNode } from '../types.js';
import type {
  AnyNode,
  ControlFlowEdge,
  DataFlowEdge,
} from '../../spec/types.js';
import { State } from '../../state/state.js';

const testdataDir = join(import.meta.dirname, '../../../testdata');

/**
 * One compiled node, with only the parts `validate` reads spelled out.
 *
 * `spec` is whatever the node's own type carries — a BranchingNode's `mapping`,
 * any node's `branches` — and the executor is a stub, because validation is a
 * question about the document and never runs one.
 */
function node(
  name: string,
  type: string,
  spec: Record<string, unknown> = {},
  edges: ControlFlowEdge[] = [],
): CompiledNode {
  return {
    name,
    type,
    specNode: { componentType: type, name, ...spec } as unknown as AnyNode,
    executor: {
      execute: async (_signal: AbortSignal | undefined, input: State) => input,
      branch: () => '',
    },
    edges,
    inputMappings: new Map(),
  };
}

function edge(from: string, to: string, branch?: string): ControlFlowEdge {
  return { fromNode: from, toNode: to, fromBranch: branch };
}

/** A graph starting at the first node given. */
function graphOf(nodes: CompiledNode[], data: DataFlowEdge[] = []) {
  return new CompiledGraph(
    'test',
    new Map(nodes.map((compiled) => [compiled.name, compiled])),
    nodes[0]!.name,
    data,
  );
}

describe('validate graph', () => {
  it('validates simple flow', () => {
    const data = readFileSync(join(testdataDir, 'simple_flow.json'), 'utf-8');
    const pf = parseFlow(data);
    const cg = compile(pf, {});
    expect(() => validate(cg)).not.toThrow();
  });

  it('validates branching flow', () => {
    const data = readFileSync(
      join(testdataDir, 'branching_flow.json'),
      'utf-8',
    );
    const pf = parseFlow(data);
    const cg = compile(pf, {});
    expect(() => validate(cg)).not.toThrow();
  });

  it('detects orphan node', () => {
    const g = graphOf([
      node('start', 'StartNode', {}, [edge('start', 'end')]),
      node('end', 'EndNode'),
      node('orphan', 'AgentNode'),
    ]);

    expect(() => validate(g)).toThrow(/orphan.*unreachable/);
  });

  it('refuses a flow that declares a state key heddle reserves', () => {
    const flow = parseFlow(
      readFileSync(join(testdataDir, 'simple_flow.json'), 'utf-8'),
    );
    const startNode = flow.parsedNodes.find(
      (node) => node.componentType === 'StartNode',
    ) as { outputs?: unknown[] };
    startNode.outputs = [
      { title: '_chat_history', type: 'string' },
    ];

    expect(() => validate(compile(flow, {}))).toThrow(
      /declares an output "_chat_history", which heddle reserves/,
    );
  });
});

describe('validate branch routing', () => {
  it('rejects a mapping to a branch no edge leaves on', () => {
    const g = graphOf([
      node('start', 'StartNode', {}, [edge('start', 'route')]),
      node(
        'route',
        'BranchingNode',
        { mapping: { yes: 'yes_branch', no: 'nowhere_branch' } },
        [edge('route', 'end', 'yes_branch')],
      ),
      node('end', 'EndNode'),
    ]);

    expect(() => validate(g)).toThrow(
      /maps "no" to branch "nowhere_branch".*no control flow edge leaves/,
    );
  });

  it('accepts a mapping whose branches all have edges', () => {
    const g = graphOf([
      node('start', 'StartNode', {}, [edge('start', 'route')]),
      node(
        'route',
        'BranchingNode',
        { mapping: { yes: 'yes_branch', DEFAULT_BRANCH: 'no_branch' } },
        [edge('route', 'end', 'yes_branch'), edge('route', 'end', 'no_branch')],
      ),
      node('end', 'EndNode'),
    ]);

    expect(() => validate(g)).not.toThrow();
  });

  it('accepts an unmatched mapping when an unbranched edge catches it', () => {
    // `nextNode` falls back to the unbranched edge for any branch it cannot
    // match, so the run leaves the node rather than ending on it.
    const g = graphOf([
      node('start', 'StartNode', {}, [edge('start', 'route')]),
      node('route', 'BranchingNode', { mapping: { yes: 'yes_branch' } }, [
        edge('route', 'end'),
      ]),
      node('end', 'EndNode'),
    ]);

    expect(() => validate(g)).not.toThrow();
  });

  it('rejects an edge on a branch the source does not declare', () => {
    const g = graphOf([
      node('start', 'StartNode', { branches: ['next'] }, [
        edge('start', 'end', 'nowhere'),
      ]),
      node('end', 'EndNode'),
    ]);

    expect(() => validate(g)).toThrow(
      /leaves on branch "nowhere", which "start" never selects/,
    );
  });

  it('leaves a node that declares no branches alone', () => {
    const g = graphOf([
      node('start', 'StartNode', {}, [edge('start', 'end', 'anything')]),
      node('end', 'EndNode'),
    ]);

    expect(() => validate(g)).not.toThrow();
  });

  it('checks a BranchingNode edge against its mapping, not its branches', () => {
    // A BranchingNode's executor answers with a mapping value and never reads
    // `branches`, so an edge on a mapped branch is live whatever it declares.
    const g = graphOf([
      node('start', 'StartNode', {}, [edge('start', 'route')]),
      node(
        'route',
        'BranchingNode',
        { branches: ['stale'], mapping: { yes: 'yes_branch' } },
        [edge('route', 'end', 'yes_branch')],
      ),
      node('end', 'EndNode'),
    ]);

    expect(() => validate(g)).not.toThrow();
  });

  it('rejects a BranchingNode edge on a branch nothing maps to', () => {
    const g = graphOf([
      node('start', 'StartNode', {}, [edge('start', 'route')]),
      node('route', 'BranchingNode', { mapping: { yes: 'yes_branch' } }, [
        edge('route', 'end', 'yes_branch'),
        edge('route', 'end', 'unmapped_branch'),
      ]),
      node('end', 'EndNode'),
    ]);

    expect(() => validate(g)).toThrow(
      /leaves on branch "unmapped_branch", which "route" never selects/,
    );
  });

  it('accepts a BranchingNode edge on the fallback branch', () => {
    const g = graphOf([
      node('start', 'StartNode', {}, [edge('start', 'route')]),
      node('route', 'BranchingNode', { mapping: { yes: 'yes_branch' } }, [
        edge('route', 'end', 'yes_branch'),
        edge('route', 'end', 'default'),
      ]),
      node('end', 'EndNode'),
    ]);

    expect(() => validate(g)).not.toThrow();
  });
});

describe('validate data flow', () => {
  const draftToEnd = (sourceOutput: string): DataFlowEdge => ({
    sourceNode: 'draft',
    sourceOutput,
    destinationNode: 'end',
    destinationInput: 'result',
  });

  function withLlmNode(data: DataFlowEdge[]) {
    return graphOf(
      [
        node('start', 'StartNode', {}, [edge('start', 'draft')]),
        node(
          'draft',
          'LlmNode',
          { outputs: [{ title: 'summary', type: 'string' }] },
          [edge('draft', 'end')],
        ),
        node('end', 'EndNode'),
      ],
      data,
    );
  }

  it('rejects reading an output an LlmNode cannot produce', () => {
    expect(() => validate(withLlmNode([draftToEnd('summary')]))).toThrow(
      /reads output "summary" from LlmNode "draft", which only produces generated_text/,
    );
  });

  it('accepts reading generated_text from an LlmNode', () => {
    expect(() =>
      validate(withLlmNode([draftToEnd('generated_text')])),
    ).not.toThrow();
  });

  it('leaves an open output set alone', () => {
    // An AgentNode writes `result` plus whatever keys its answer parsed to, so
    // what it produces is not knowable from the document.
    const g = graphOf(
      [
        node('start', 'StartNode', {}, [edge('start', 'agent')]),
        node('agent', 'AgentNode', {}, [edge('agent', 'end')]),
        node('end', 'EndNode'),
      ],
      [
        {
          sourceNode: 'agent',
          sourceOutput: 'anything',
          destinationNode: 'end',
          destinationInput: 'result',
        },
      ],
    );

    expect(() => validate(g)).not.toThrow();
  });

  it('rejects reading from a node the flow does not have', () => {
    const g = graphOf(
      [
        node('start', 'StartNode', {}, [edge('start', 'end')]),
        node('end', 'EndNode'),
      ],
      [
        {
          sourceNode: 'ghost',
          sourceOutput: 'result',
          destinationNode: 'end',
          destinationInput: 'result',
        },
      ],
    );

    expect(() => validate(g)).toThrow(
      /reads from "ghost", which is not a node in this flow/,
    );
  });
});
