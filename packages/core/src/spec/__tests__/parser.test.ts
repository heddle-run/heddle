import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFlow, parseComponent } from '../parser.js';
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
