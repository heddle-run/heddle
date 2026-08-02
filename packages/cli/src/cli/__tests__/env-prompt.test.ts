import { describe, it, expect } from 'vitest';
import type { AnyNode, ParsedFlow } from '@heddle-run/core';
import { askForEnvRefs } from '../env-prompt.js';

/** A flow that only `collectEnvRefs` will read, so only its nodes are real. */
function flowReading(...keys: string[]): ParsedFlow {
  const nodes = keys.map((key, index) => ({
    componentType: 'LlmNode',
    name: `n${index}`,
    promptTemplate: 'hi',
    llmConfig: { modelId: 'gpt-4o-mini', apiKey: `$${key}` },
  }));

  return { parsedNodes: nodes as unknown as AnyNode[] } as ParsedFlow;
}

/** An answering terminal: what it was asked, and what it says back. */
function terminal(answers: Record<string, string>) {
  const asked: string[] = [];
  const written: string[] = [];

  return {
    asked,
    written,
    options: {
      interactive: true,
      write: (text: string) => written.push(text),
      read: (question: string) => {
        asked.push(question.trim().replace(/:$/, ''));
        return Promise.resolve(answers[asked[asked.length - 1]] ?? '');
      },
    },
  };
}

describe('asking for the variables a flow names', () => {
  it('asks for the one that is missing, and keeps the answer', async () => {
    const io = terminal({ OPENAI_API_KEY: 'sk-typed' });
    const env: NodeJS.ProcessEnv = {};

    const filled = await askForEnvRefs(flowReading('OPENAI_API_KEY'), {
      ...io.options,
      env,
    });

    expect(io.asked).toEqual(['OPENAI_API_KEY']);
    expect(env.OPENAI_API_KEY).toBe('sk-typed');
    expect(filled).toEqual(['OPENAI_API_KEY']);
  });

  it('says nothing at all when every variable is already set', async () => {
    const io = terminal({});
    const env = { OPENAI_API_KEY: 'sk-exported' };

    const filled = await askForEnvRefs(flowReading('OPENAI_API_KEY'), {
      ...io.options,
      env,
    });

    expect(io.asked).toEqual([]);
    expect(io.written).toEqual([]);
    expect(filled).toEqual([]);
    expect(env.OPENAI_API_KEY).toBe('sk-exported');
  });

  it('treats a variable set to nothing as one to ask about', async () => {
    const io = terminal({ OPENAI_API_KEY: 'sk-typed' });
    const env = { OPENAI_API_KEY: '' };

    await askForEnvRefs(flowReading('OPENAI_API_KEY'), { ...io.options, env });

    expect(env.OPENAI_API_KEY).toBe('sk-typed');
  });

  it('asks once per variable, in the order the flow named them', async () => {
    const io = terminal({ A_KEY: 'a', B_KEY: 'b' });
    const env: NodeJS.ProcessEnv = {};

    await askForEnvRefs(flowReading('A_KEY', 'B_KEY', 'A_KEY'), {
      ...io.options,
      env,
    });

    expect(io.asked).toEqual(['A_KEY', 'B_KEY']);
    expect(env).toEqual({ A_KEY: 'a', B_KEY: 'b' });
  });

  it('leaves a variable unset when the answer is empty, and runs anyway', async () => {
    const io = terminal({ B_KEY: 'b' });
    const env: NodeJS.ProcessEnv = {};

    const filled = await askForEnvRefs(flowReading('A_KEY', 'B_KEY'), {
      ...io.options,
      env,
    });

    expect(filled).toEqual(['B_KEY']);
    expect('A_KEY' in env).toBe(false);
  });

  it('drops the whitespace a pasted credential brought with it', async () => {
    const io = terminal({ OPENAI_API_KEY: '  sk-typed \t' });
    const env: NodeJS.ProcessEnv = {};

    await askForEnvRefs(flowReading('OPENAI_API_KEY'), { ...io.options, env });

    expect(env.OPENAI_API_KEY).toBe('sk-typed');
  });

  it('asks nothing with no terminal to answer, leaving the run as it was', async () => {
    const io = terminal({ OPENAI_API_KEY: 'sk-typed' });
    const env: NodeJS.ProcessEnv = {};

    const filled = await askForEnvRefs(flowReading('OPENAI_API_KEY'), {
      ...io.options,
      interactive: false,
      env,
    });

    expect(io.asked).toEqual([]);
    expect(io.written).toEqual([]);
    expect(filled).toEqual([]);
    expect('OPENAI_API_KEY' in env).toBe(false);
  });

  it('names what it is asking about, and why, before asking', async () => {
    const io = terminal({ OPENAI_API_KEY: 'sk-typed' });

    await askForEnvRefs(flowReading('OPENAI_API_KEY'), {
      ...io.options,
      env: {},
    });

    const said = io.written.join('');
    expect(said).toContain('OPENAI_API_KEY is not set');
    expect(said).toContain('this run only');
  });
});
