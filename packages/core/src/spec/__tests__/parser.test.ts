import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseFlow,
  parseComponent,
  parseAgent,
  parseComponentJson,
  parseComponentYaml,
} from '../parser.js';
import { PluginRegistry } from '../../plugin/registry.js';
import { definePlugin } from '../../plugin/types.js';
import type { AgentNode, BranchingNode, Agent } from '../types.js';

const testdataDir = join(import.meta.dirname, '../../../testdata');

describe('parseFlow', () => {
  it('parses simple flow', () => {
    const data = readFileSync(join(testdataDir, 'simple_flow.json'), 'utf-8');
    const pf = parseFlow(data);

    expect(pf.name).toBe('simple-flow');
    expect(pf.parsedNodes.length).toBe(2);

    let hasStart = false;
    let hasEnd = false;
    for (const n of pf.parsedNodes) {
      if (n.componentType === 'StartNode') hasStart = true;
      if (n.componentType === 'EndNode') hasEnd = true;
    }
    expect(hasStart).toBe(true);
    expect(hasEnd).toBe(true);
  });

  it('parses branching flow', () => {
    const data = readFileSync(
      join(testdataDir, 'branching_flow.json'),
      'utf-8',
    );
    const pf = parseFlow(data);

    expect(pf.name).toBe('branching-flow');

    const bn = pf.parsedNodes.find(
      (n) => n.componentType === 'BranchingNode',
    ) as BranchingNode | undefined;
    expect(bn).toBeDefined();
    expect(Object.keys(bn!.mapping).length).toBe(3);
  });

  it('parses agent with tools', () => {
    const data = readFileSync(
      join(testdataDir, 'agent_with_tools.json'),
      'utf-8',
    );
    const pf = parseFlow(data);

    const an = pf.parsedNodes.find(
      (n) => n.componentType === 'AgentNode',
    ) as AgentNode | undefined;
    expect(an).toBeDefined();
    expect(an!.agent).toBeDefined();
    expect(an!.agent!.tools!.length).toBe(1);
    expect(an!.agent!.tools![0].name).toBe('echo_tool');
  });

  it('rejects invalid component_type', () => {
    const data = '{"component_type": "Invalid", "name": "test"}';
    expect(() => parseFlow(data)).toThrow();
  });
});

describe('parseComponent', () => {
  it('parses agent component', () => {
    const agentJSON = JSON.stringify({
      component_type: 'Agent',
      name: 'test-agent',
      system_prompt: 'hello',
      llm_config: {
        component_type: 'OpenAiConfig',
        name: 'openai',
        model_id: 'gpt-4o',
      },
    });

    const comp = parseComponent(agentJSON);
    const agent = comp as Agent;
    expect(agent.name).toBe('test-agent');
    expect(agent.componentType).toBe('Agent');
  });
});

// ---------------------------------------------------------------------------
// A standalone Agent is not a Flow, and used to be the path where a plugin
// transform came back as the stand-in heddle swapped in for the SDK's benefit —
// a MessageSummarizationTransform pointing at an Ollama config nobody
// configured. `heddle validate <agent> --plugin` printed that, and any path
// that ran a standalone Agent would have run none of its real transforms.
// ---------------------------------------------------------------------------

const REDACTOR = definePlugin({
  name: 'test-redactor',
  version: '1.0.0',
  transforms: [
    {
      componentType: 'Redactor',
      createTransform: () => ({ apply: () => ({ action: 'pass' as const }) }),
    },
  ],
});

function redactorRegistry(): PluginRegistry {
  return PluginRegistry.fromPlugins([REDACTOR]);
}

const AGENT_DOC = {
  component_type: 'Agent',
  id: 'a1',
  name: 'guarded-agent',
  system_prompt: 'be careful',
  llm_config: {
    component_type: 'OpenAiConfig',
    id: 'l1',
    name: 'gpt',
    model_id: 'gpt-4o',
  },
  transforms: [
    {
      component_type: 'Redactor',
      id: 't1',
      name: 'scrubber',
      config: { patterns: ['secret'] },
    },
  ],
};

const AGENT_JSON = JSON.stringify(AGENT_DOC);

/** The one thing every entry point below has to get right. */
function expectRealTransform(agent: Agent): void {
  expect(agent.transforms).toMatchObject([
    { componentType: 'Redactor', name: 'scrubber' },
  ]);
}

describe('a standalone Agent carrying a plugin transform', () => {
  it('comes back from parseAgent with the real transform', () => {
    expectRealTransform(parseAgent(AGENT_JSON, redactorRegistry()));
  });

  it('comes back from parseComponent with the real transform', () => {
    const agent = parseComponent(AGENT_JSON, redactorRegistry()) as Agent;
    expectRealTransform(agent);
  });

  it('comes back from parseComponentJson with the real transform', () => {
    const agent = parseComponentJson(
      AGENT_JSON,
      redactorRegistry(),
    ) as unknown as Agent;
    expectRealTransform(agent);
  });

  it('comes back from parseComponentYaml with the real transform', () => {
    const yaml = [
      'component_type: Agent',
      'id: a1',
      'name: guarded-agent',
      'system_prompt: be careful',
      'llm_config:',
      '  component_type: OpenAiConfig',
      '  id: l1',
      '  name: gpt',
      '  model_id: gpt-4o',
      'transforms:',
      '  - component_type: Redactor',
      '    id: t1',
      '    name: scrubber',
    ].join('\n');

    const agent = parseComponentYaml(yaml, redactorRegistry()) as unknown as Agent;
    expectRealTransform(agent);
  });

  it('keeps the transform own fields, not the stand-in llm', () => {
    const agent = parseAgent(AGENT_JSON, redactorRegistry());
    const transform = agent.transforms![0] as unknown as {
      config?: { patterns?: string[] };
      llm?: unknown;
    };

    expect(transform.config?.patterns).toEqual(['secret']);
    // The stand-in carried a synthesized OllamaConfig. Nothing downstream
    // should be able to see it, let alone dial it.
    expect(transform.llm).toBeUndefined();
  });

  it('leaves an agent with no plugin transforms alone', () => {
    const plain = JSON.stringify({ ...AGENT_DOC, transforms: [] });
    const agent = parseAgent(plain, redactorRegistry());

    expect(agent.name).toBe('guarded-agent');
    expect(agent.transforms).toEqual([]);
  });
});
