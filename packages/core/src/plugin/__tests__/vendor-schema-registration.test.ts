import { describe, it, expect, afterEach } from 'vitest';
import {
  LlmConfigUnion,
  MessageTransformUnion,
  NodeUnion,
  registerFlowSchema,
  registerLlmConfigSchema,
  registerMessageTransformSchema,
  registerNodeUnionSchema,
} from 'agentspec';
import { parseFlow } from '../../spec/parser.js';
import { installWidenedUnions } from '../../spec/open-unions.js';

const FLOW = JSON.stringify({
  component_type: 'Flow',
  name: 'plain',
  start_node: { $component_ref: 's' },
  nodes: [{ $component_ref: 's' }, { $component_ref: 'e' }],
  control_flow_connections: [
    {
      component_type: 'ControlFlowEdge',
      name: 'go',
      from_node: { $component_ref: 's' },
      to_node: { $component_ref: 'e' },
    },
  ],
  $referenced_components: {
    s: { component_type: 'StartNode', id: 's', name: 's', outputs: [] },
    e: { component_type: 'EndNode', id: 'e', name: 'e' },
  },
});

const AGENT_FLOW = JSON.stringify({
  component_type: 'Flow',
  name: 'agenty',
  start_node: { $component_ref: 's' },
  nodes: [{ $component_ref: 's' }, { $component_ref: 'a' }, { $component_ref: 'e' }],
  control_flow_connections: [
    {
      component_type: 'ControlFlowEdge',
      name: 'go',
      from_node: { $component_ref: 's' },
      to_node: { $component_ref: 'a' },
    },
    {
      component_type: 'ControlFlowEdge',
      name: 'done',
      from_node: { $component_ref: 'a' },
      to_node: { $component_ref: 'e' },
    },
  ],
  $referenced_components: {
    s: { component_type: 'StartNode', id: 's', name: 's', outputs: [] },
    a: {
      component_type: 'AgentNode',
      id: 'a',
      name: 'a',
      agent: {
        component_type: 'Agent',
        name: 'assistant',
        system_prompt: 'hi',
        llm_config: {
          component_type: 'OpenAiConfig',
          name: 'llm',
          model_id: 'gpt-4o-mini',
        },
      },
    },
    e: { component_type: 'EndNode', id: 'e', name: 'e' },
  },
});

afterEach(() => {
  registerNodeUnionSchema(NodeUnion);
  registerMessageTransformSchema(MessageTransformUnion);
  registerLlmConfigSchema(LlmConfigUnion);
});

describe('the vendored SDK schema registration', () => {
  it('exports every registration function from the package root', () => {
    expect(typeof registerNodeUnionSchema).toBe('function');
    expect(typeof registerFlowSchema).toBe('function');
    expect(typeof registerMessageTransformSchema).toBe('function');
    expect(typeof registerLlmConfigSchema).toBe('function');
  });

  it('is the schema a flow’s nodes are really validated against', () => {
    expect(parseFlow(FLOW).name).toBe('plain');

    registerNodeUnionSchema(NodeUnion.refine(() => false, 'nodes rebound by the test'));
    expect(() => parseFlow(FLOW)).toThrow(/nodes rebound by the test/);
  });

  it('is the schema an llm_config is really validated against', () => {
    expect(parseFlow(AGENT_FLOW).name).toBe('agenty');

    registerLlmConfigSchema(LlmConfigUnion.refine(() => false, 'llm rebound by the test'));
    expect(() => parseFlow(AGENT_FLOW)).toThrow(/llm rebound by the test/);
  });

  it('widens through the seams rather than around them', () => {
    installWidenedUnions();
    installWidenedUnions();
    expect(parseFlow(FLOW).name).toBe('plain');
    expect(parseFlow(AGENT_FLOW).name).toBe('agenty');
  });
});
