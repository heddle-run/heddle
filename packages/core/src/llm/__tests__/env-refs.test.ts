import { describe, it, expect } from 'vitest';
import { collectEnvRefs, envRefKey, isEnvRef } from '../env-refs.js';
import { parseFlow } from '../../spec/parser.js';
import type { AnyNode, ParsedFlow } from '../../spec/types.js';

/** A flow that only `collectEnvRefs` will read, so only its nodes are real. */
function flowOf(...parsedNodes: unknown[]): ParsedFlow {
  return { parsedNodes: parsedNodes as AnyNode[] } as ParsedFlow;
}

function llmNode(apiKey: unknown): unknown {
  return {
    componentType: 'LlmNode',
    name: 'draft',
    promptTemplate: 'hi',
    llmConfig: { componentType: 'OpenAiConfig', modelId: 'gpt-4o-mini', apiKey },
  };
}

const START = {
  component_type: 'StartNode',
  id: 's',
  name: 'start',
  outputs: [{ title: 'query', type: 'string' }],
  branches: ['next'],
};

const END = {
  component_type: 'EndNode',
  id: 'e',
  name: 'end',
  inputs: [{ title: 'result', type: 'string' }],
  branches: [],
};

function edge(name: string, from: string, to: string): unknown {
  return {
    component_type: 'ControlFlowEdge',
    name,
    from_node: { $component_ref: from },
    from_branch: null,
    to_node: { $component_ref: to },
  };
}

describe('what a value with a $ means', () => {
  it('is a reference, whose key is the rest of it', () => {
    expect(isEnvRef('$OPENAI_API_KEY')).toBe(true);
    expect(envRefKey('$OPENAI_API_KEY')).toBe('OPENAI_API_KEY');
  });

  it('is not one when the value is the credential itself', () => {
    expect(isEnvRef('sk-literal')).toBe(false);
  });
});

describe('the variables a flow names', () => {
  it('finds the one an LlmNode reads', () => {
    expect(collectEnvRefs(flowOf(llmNode('$OPENAI_API_KEY')))).toEqual([
      'OPENAI_API_KEY',
    ]);
  });

  it('finds the one an agent reads, two levels down', () => {
    const node = {
      componentType: 'AgentNode',
      name: 'coder',
      agent: {
        componentType: 'Agent',
        name: 'coder',
        llmConfig: { modelId: 'gpt-4o', apiKey: '$OPENAI_API_KEY' },
      },
    };

    expect(collectEnvRefs(flowOf(node))).toEqual(['OPENAI_API_KEY']);
  });

  it('finds one a plugin node put somewhere heddle has no type for', () => {
    const node = {
      componentType: 'ResearchNode',
      name: 'research',
      models: [{ llm_config: { model_id: 'm', api_key: '$TAVILY_API_KEY' } }],
    };

    expect(collectEnvRefs(flowOf(node))).toEqual(['TAVILY_API_KEY']);
  });

  it('names each variable once, however many configs read it', () => {
    expect(
      collectEnvRefs(
        flowOf(llmNode('$OPENAI_API_KEY'), llmNode('$OPENAI_API_KEY')),
      ),
    ).toEqual(['OPENAI_API_KEY']);
  });

  it('is empty for a key the spec carries literally', () => {
    expect(collectEnvRefs(flowOf(llmNode('sk-literal')))).toEqual([]);
  });

  it('ignores a $ that is not a credential, so prompts stay prompts', () => {
    const node = {
      componentType: 'LlmNode',
      name: 'draft',
      promptTemplate: 'Is $PATH under $20?',
      llmConfig: { modelId: 'gpt-4o-mini' },
    };

    expect(collectEnvRefs(flowOf(node))).toEqual([]);
  });

  it('ignores a bare $, which names nothing that could be answered', () => {
    expect(collectEnvRefs(flowOf(llmNode('$')))).toEqual([]);
  });

  it('terminates on a document that refers to itself', () => {
    const node: Record<string, unknown> = llmNode('$OPENAI_API_KEY') as Record<
      string,
      unknown
    >;
    node.self = node;

    expect(collectEnvRefs(flowOf(node))).toEqual(['OPENAI_API_KEY']);
  });

  it('reads a real document, whose keys the SDK renamed on the way in', () => {
    const document = {
      component_type: 'Flow',
      agentspec_version: '26.2.0',
      name: 'test-flow',
      start_node: { $component_ref: 's' },
      nodes: [
        { $component_ref: 's' },
        { $component_ref: 'draft' },
        { $component_ref: 'e' },
      ],
      control_flow_connections: [
        edge('s_to_draft', 's', 'draft'),
        edge('draft_to_e', 'draft', 'e'),
      ],
      $referenced_components: {
        s: START,
        e: END,
        draft: {
          component_type: 'LlmNode',
          id: 'draft',
          name: 'draft',
          prompt_template: 'Summarise: {{query}}',
          llm_config: {
            component_type: 'OpenAiConfig',
            name: 'gpt',
            model_id: 'gpt-4o-mini',
            api_key: '$OPENAI_API_KEY',
          },
          outputs: [{ title: 'generated_text', type: 'string' }],
          branches: ['next'],
        },
      },
    };

    expect(collectEnvRefs(parseFlow(JSON.stringify(document)))).toEqual([
      'OPENAI_API_KEY',
    ]);
  });
});
