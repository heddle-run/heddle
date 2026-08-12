import { describe, it, expect } from 'vitest';
import { collectEnvRefs, envRefKey, isEnvRef } from '../env-refs.js';
import { parseFlowYaml } from '../../spec/parser.js';
import type { ModelSpec, ParsedFlow, Step } from '../../spec/types.js';

/** A flow that only `collectEnvRefs` will read, so only steps and models are real. */
function flowOf(
  steps: unknown[],
  models: Record<string, ModelSpec> = {},
): ParsedFlow {
  return {
    name: 'test',
    inputs: {},
    models,
    tools: {},
    steps: steps as Step[],
    outcomes: [],
    requires: {},
    meta: {},
  };
}

function model(apiKey?: unknown): ModelSpec {
  const spec: ModelSpec = { provider: 'openai', model: 'gpt-4o-mini', extra: {} };
  if (apiKey !== undefined) spec.api_key = apiKey as string;
  return spec;
}

function llmStep(apiKey: unknown, prompt = 'hi'): unknown {
  return { kind: 'llm', name: 'draft', model: model(apiKey), prompt };
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
  it('finds the one an llm step reads', () => {
    expect(collectEnvRefs(flowOf([llmStep('$OPENAI_API_KEY')]))).toEqual([
      'OPENAI_API_KEY',
    ]);
  });

  it('finds the one an agent reads, two levels down', () => {
    const step = {
      kind: 'agent',
      name: 'coder',
      agent: {
        model: model('$OPENAI_API_KEY'),
        prompt: 'code it',
        tools: [],
        transforms: [],
      },
    };

    expect(collectEnvRefs(flowOf([step]))).toEqual(['OPENAI_API_KEY']);
  });

  it('finds one a plugin step put somewhere heddle has no type for', () => {
    const step = {
      kind: 'use',
      name: 'research',
      use: 'ResearchNode',
      config: { models: [{ model: 'm', api_key: '$TAVILY_API_KEY' }] },
    };

    expect(collectEnvRefs(flowOf([step]))).toEqual(['TAVILY_API_KEY']);
  });

  it('finds one in the models map, even before any step names it', () => {
    expect(collectEnvRefs(flowOf([], { fast: model('$OPENAI_API_KEY') }))).toEqual([
      'OPENAI_API_KEY',
    ]);
  });

  it('names each variable once, however many models read it', () => {
    expect(
      collectEnvRefs(
        flowOf([llmStep('$OPENAI_API_KEY'), llmStep('$OPENAI_API_KEY')]),
      ),
    ).toEqual(['OPENAI_API_KEY']);
  });

  it('is empty for a key the spec carries literally', () => {
    expect(collectEnvRefs(flowOf([llmStep('sk-literal')]))).toEqual([]);
  });

  it('ignores a $ that is not a credential, so prompts stay prompts', () => {
    expect(
      collectEnvRefs(flowOf([llmStep(undefined, 'Is $PATH under $20?')])),
    ).toEqual([]);
  });

  it('ignores a bare $, which names nothing that could be answered', () => {
    expect(collectEnvRefs(flowOf([llmStep('$')]))).toEqual([]);
  });

  it('terminates on a document that refers to itself', () => {
    const step: Record<string, unknown> = llmStep('$OPENAI_API_KEY') as Record<
      string,
      unknown
    >;
    step.self = step;

    expect(collectEnvRefs(flowOf([step]))).toEqual(['OPENAI_API_KEY']);
  });

  it('reads a real document, straight through the parser', () => {
    const document = `
weave: 1
name: test-flow
inputs:
  query: string
models:
  gpt:
    provider: openai
    model: gpt-4o-mini
    api_key: $OPENAI_API_KEY
steps:
  - name: draft
    llm:
      model: gpt
      prompt: 'Summarise: {{inputs.query}}'
`;

    expect(collectEnvRefs(parseFlowYaml(document))).toEqual(['OPENAI_API_KEY']);
  });
});
