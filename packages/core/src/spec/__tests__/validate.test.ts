import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFlow } from '../parser.js';
import { validateFlow, validateAgent } from '../validate.js';
import type { Agent, LLMConfig } from '../types.js';

const testdataDir = join(import.meta.dirname, '../../../testdata');

describe('validateFlow', () => {
  it('validates simple flow', () => {
    const data = readFileSync(join(testdataDir, 'simple_flow.json'), 'utf-8');
    const pf = parseFlow(data);
    expect(() => validateFlow(pf)).not.toThrow();
  });

  it('validates branching flow', () => {
    const data = readFileSync(
      join(testdataDir, 'branching_flow.json'),
      'utf-8',
    );
    const pf = parseFlow(data);
    expect(() => validateFlow(pf)).not.toThrow();
  });

  it('validates agent flow', () => {
    const data = readFileSync(
      join(testdataDir, 'agent_with_tools.json'),
      'utf-8',
    );
    const pf = parseFlow(data);
    expect(() => validateFlow(pf)).not.toThrow();
  });
});

describe('validateAgent', () => {
  it('validates a valid agent', () => {
    const agent: Agent = {
      name: 'test',
      componentType: 'Agent',
      systemPrompt: 'hello',
      llmConfig: { modelId: 'gpt-4o' } as LLMConfig,
    };
    expect(() => validateAgent(agent)).not.toThrow();
  });

  it('rejects agent missing name', () => {
    const agent: Agent = {
      name: '',
      componentType: 'Agent',
      systemPrompt: 'hello',
      llmConfig: { modelId: 'gpt-4o' } as LLMConfig,
    };
    expect(() => validateAgent(agent)).toThrow(/name/);
  });
});
