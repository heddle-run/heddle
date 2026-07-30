import { describe, it, expect } from 'vitest';
import { isBuiltinComponentType } from 'agentspec';
import { parseFlow } from '../parser.js';
import { installWidenedUnions } from '../open-unions.js';
import { PluginRegistry } from '../../plugin/registry.js';
import type { HeddlePlugin } from '../../plugin/types.js';

function flowWith(middle: Record<string, unknown> | undefined): string {
  const refs: Record<string, unknown> = {
    s: {
      component_type: 'StartNode',
      id: 's',
      name: 'start',
      outputs: [{ title: 'text', type: 'string' }],
    },
    e: { component_type: 'EndNode', id: 'e', name: 'end' },
  };
  const nodes: unknown[] = [{ $component_ref: 's' }];
  const edges: unknown[] = [];

  if (middle) {
    refs.p = { id: 'p', name: 'p', ...middle };
    nodes.push({ $component_ref: 'p' });
    edges.push(
      { component_type: 'ControlFlowEdge', name: 'a', from_node: { $component_ref: 's' }, to_node: { $component_ref: 'p' } },
      { component_type: 'ControlFlowEdge', name: 'b', from_node: { $component_ref: 'p' }, to_node: { $component_ref: 'e' } },
    );
  } else {
    edges.push({ component_type: 'ControlFlowEdge', name: 'a', from_node: { $component_ref: 's' }, to_node: { $component_ref: 'e' } });
  }
  nodes.push({ $component_ref: 'e' });

  return JSON.stringify({
    component_type: 'Flow',
    name: 'f',
    start_node: { $component_ref: 's' },
    nodes,
    control_flow_connections: edges,
    end_nodes: [{ $component_ref: 'e' }],
    $referenced_components: refs,
  });
}

function pluginWith(over: Partial<HeddlePlugin>): PluginRegistry {
  return PluginRegistry.fromPlugins([
    { name: 'kinds', version: '1.0.0', ...over } as HeddlePlugin,
  ]);
}

describe('what a builtin still gets', () => {
  it('reports a builtin in the wrong slot exactly as it did before widening', () => {
    let caught: unknown;
    try {
      parseFlow(flowWith({ component_type: 'Agent' }));
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).constructor.name).toBe('ZodError');
    expect((caught as Error).message).toMatch(/"code": "invalid_type"/);
  });

  it('still refuses a malformed builtin node', () => {
    expect(() =>
      parseFlow(
        flowWith({ component_type: 'BranchingNode' }),
      ),
    ).toThrow();
  });

  it('leaves isBuiltinComponentType the thing the widening asks', () => {
    expect(isBuiltinComponentType('StartNode')).toBe(true);
    expect(isBuiltinComponentType('NotAThing')).toBe(false);
  });
});

describe('a component in the wrong slot', () => {
  const node = {
    componentType: 'Doer',
    createExecutor: () => ({ execute: async () => ({ output: {} }) }),
  };
  const transform = {
    componentType: 'Guard',
    createTransform: () => ({ apply: () => ({ action: 'pass' as const }) }),
  };

  it('accepts a plugin node where a node belongs', () => {
    const registry = pluginWith({ nodes: [node] });
    const flow = parseFlow(
      flowWith({ component_type: 'Doer' }),
      registry,
    );
    expect(flow.parsedNodes.map((n) => n.componentType)).toContain('Doer');
  });

  it('refuses a plugin transform written into nodes, naming its kind', () => {
    const registry = pluginWith({ transforms: [transform] });
    expect(() =>
      parseFlow(
        flowWith({ component_type: 'Guard' }),
        registry,
      ),
    ).toThrow(/provides as a transform rather than a node/);
  });

  it('refuses a middleware written into a document at all', () => {
    const registry = pluginWith({
      middleware: [
        {
          componentType: 'Retry',
          seams: { nodeError: ['after'] },
          createMiddleware: () => ({ after: () => ({ action: 'pass' as const }) }),
        },
      ],
    });
    expect(() =>
      parseFlow(
        flowWith({ component_type: 'Retry' }),
        registry,
      ),
    ).toThrow(/is a middleware/);
  });

  it('still names the loaded plugins for a type nothing provides', () => {
    const registry = pluginWith({ nodes: [node] });
    expect(() =>
      parseFlow(
        flowWith({ component_type: 'Doerr' }),
        registry,
      ),
    ).toThrow(/no loaded plugin provides[\s\S]*kinds@1\.0\.0/);
  });
});

describe('installing the widened unions', () => {
  it('is idempotent, which is what lets every run share one registration', () => {
    installWidenedUnions();
    installWidenedUnions();
    expect(() => parseFlow(flowWith(undefined))).not.toThrow();
  });

  it('leaves a transform slot open, so a plugin transform deserializes in place', () => {
    const registry = pluginWith({
      transforms: [{ componentType: 'Guard', createTransform: () => ({ apply: () => ({ action: 'pass' as const }) }) }],
    });
    const flow = parseFlow(
      flowWith(
        {
            component_type: 'AgentNode',
            agent: {
              component_type: 'Agent',
              name: 'a',
              system_prompt: 'hi',
              llm_config: {
                component_type: 'OpenAiConfig',
                name: 'llm',
                model_id: 'gpt-4o-mini',
              },
              transforms: [{ component_type: 'Guard', name: 'g' }],
            },
        },
      ),
      registry,
    );

    const node = flow.parsedNodes.find((n) => n.name === 'p') as {
      agent?: { transforms?: Array<{ componentType?: string; name?: string }> };
    };
    expect(node.agent?.transforms?.[0]?.componentType).toBe('Guard');
    expect(node.agent?.transforms?.[0]?.name).toBe('g');
  });
});
