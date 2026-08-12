import { describe, it, expect } from 'vitest';
import { parseFlowObject } from '../../spec/parser.js';
import { compile } from '../compile.js';
import { PluginRegistry } from '../../plugin/registry.js';
import { definePlugin } from '../../plugin/types.js';

const MODEL = { provider: 'openai', model: 'gpt-4o' };

const SIMPLE = {
  weave: 1,
  name: 'simple-flow',
  inputs: { question: 'string' },
  steps: [
    {
      name: 'draft',
      llm: { model: MODEL, prompt: 'Answer: {{inputs.question}}' },
    },
  ],
  outcomes: { done: { answer: '{{draft.text}}' } },
};

// One step of each verb, so the lowering of every kind is visible at once.
const KINDS = {
  weave: 1,
  name: 'kinds',
  inputs: { q: 'string' },
  tools: {
    echo: { inputs: { text: 'string' }, outputs: { echoed: 'string' } },
  },
  steps: [
    { name: 'ask', agent: { model: MODEL, prompt: 'hi {{inputs.q}}', tools: ['echo'] } },
    { name: 'fetch', tool: 'echo', with: { text: '{{ask.result}}' } },
    {
      name: 'route',
      switch: '{{fetch.echoed}}',
      cases: { again: 'note' },
      else: 'done',
    },
    { name: 'note', llm: { model: MODEL, prompt: 'note {{fetch.echoed}}' } },
  ],
};

describe('compile', () => {
  it('lowers a linear flow to inputs, steps and outcomes', () => {
    const cg = compile(parseFlowObject(SIMPLE), {});

    expect(cg.name).toBe('simple-flow');
    expect(cg.start).toBe('inputs');
    expect([...cg.nodes.keys()]).toEqual(['inputs', 'draft', 'done']);

    const start = cg.getNode('inputs');
    expect(start!.type).toBe('start');
    expect(start!.edges).toEqual([{ from: 'inputs', to: 'draft' }]);

    // The last step falls through to the outcome.
    expect(cg.getNode('draft')!.edges).toEqual([{ from: 'draft', to: 'done' }]);
    expect(cg.isTerminal(cg.getNode('done')!)).toBe(true);
    expect(cg.isTerminal(cg.getNode('draft')!)).toBe(false);
  });

  it('types each node by its step verb', () => {
    const cg = compile(parseFlowObject(KINDS), {});

    expect(cg.getNode('ask')!.type).toBe('agent');
    expect(cg.getNode('fetch')!.type).toBe('tool');
    expect(cg.getNode('route')!.type).toBe('switch');
    expect(cg.getNode('note')!.type).toBe('llm');
    expect(cg.getNode('done')!.type).toBe('outcome');
  });

  it('derives one branched edge per distinct switch target', () => {
    const cg = compile(parseFlowObject(KINDS), {});

    const route = cg.getNode('route')!;
    expect(route.edges).toEqual([
      { from: 'route', branch: 'note', to: 'note' },
      { from: 'route', branch: 'done', to: 'done' },
    ]);
    expect(cg.nextNode(route, 'note')!.name).toBe('note');
  });

  it('routes a then jump to its target instead of falling through', () => {
    const doc = {
      ...SIMPLE,
      name: 'jump',
      steps: [
        {
          name: 'draft',
          llm: { model: MODEL, prompt: 'hi {{inputs.question}}' },
          then: 'done',
        },
      ],
      outcomes: { done: {} },
    };

    const cg = compile(parseFlowObject(doc), {});
    expect(cg.getNode('draft')!.edges).toEqual([{ from: 'draft', to: 'done' }]);
  });

  it('turns template references into input mappings', () => {
    const cg = compile(parseFlowObject(SIMPLE), {});

    // A ref resolves under its own dotted key, read from its producer.
    expect(cg.getNode('draft')!.inputMappings.get('inputs.question')).toEqual({
      sourceNode: 'inputs',
      sourceOutput: 'question',
    });
    expect(cg.getNode('done')!.inputMappings.get('draft.text')).toEqual({
      sourceNode: 'draft',
      sourceOutput: 'text',
    });
  });
});

describe('compiling a plugin step', () => {
  const UPPER = definePlugin({
    name: 'upper-plugin',
    version: '1.0.0',
    nodes: [
      {
        componentType: 'Upper',
        inferOutputs: () => [{ title: 'shout', type: 'string' }],
        createExecutor: () => ({ execute: () => ({ output: { shout: 'HI' } }) }),
      },
    ],
  });

  const USE_DOC = {
    weave: 1,
    name: 'use-flow',
    inputs: { q: 'string' },
    steps: [{ name: 'scrub', use: 'Upper', with: { text: '{{inputs.q}}' } }],
    outcomes: { done: { out: '{{scrub.shout}}' } },
  };

  it('types the node by its component type', () => {
    const registry = PluginRegistry.fromPlugins([UPPER]);
    const cg = compile(parseFlowObject(USE_DOC, registry), {
      plugins: registry,
    });

    expect(cg.getNode('scrub')!.type).toBe('Upper');
  });

  it('refuses to compile against dependencies missing the plugin', () => {
    const registry = PluginRegistry.fromPlugins([UPPER]);
    const flow = parseFlowObject(USE_DOC, registry);

    expect(() => compile(flow, {})).toThrow(/no loaded plugin provides/);
  });
});
