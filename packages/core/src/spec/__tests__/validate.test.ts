import { describe, it, expect } from 'vitest';
import { parseFlowObject } from '../parser.js';
import { satisfies } from '../resolve.js';
import { PluginRegistry } from '../../plugin/registry.js';
import { definePlugin } from '../../plugin/types.js';

const MODEL = { provider: 'openai', model: 'gpt-4o' };

function llmStep(
  name: string,
  prompt: string,
  rest: Record<string, unknown> = {},
): Record<string, unknown> {
  return { name, llm: { model: MODEL, prompt }, ...rest };
}

function docWith(
  steps: unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { weave: 1, name: 't', inputs: { query: 'string' }, steps, ...extra };
}

/** One plugin providing a node, a transform and a provider, for the kind checks. */
const PLUGIN = definePlugin({
  name: 'test-plugin',
  version: '1.2.3',
  nodes: [
    {
      componentType: 'RegexRewrite',
      validate: (component) => {
        if (typeof component.pattern !== 'string') {
          throw new Error('RegexRewrite needs a "pattern"');
        }
      },
      inferOutputs: () => [{ title: 'text', type: 'string' }],
      createExecutor: () => ({ execute: () => ({ output: { text: '' } }) }),
    },
    {
      // No inferOutputs: the document cannot know what this writes.
      componentType: 'Opaque',
      createExecutor: () => ({ execute: () => ({ output: {} }) }),
    },
  ],
  transforms: [
    {
      componentType: 'SecretScrub',
      createTransform: () => ({ apply: () => ({ action: 'pass' as const }) }),
    },
  ],
  providers: [
    {
      componentType: 'EchoProvider',
      validate: (component) => {
        if (component.voice !== undefined && typeof component.voice !== 'string') {
          throw new Error('EchoProvider "voice" must be a string');
        }
      },
      createProvider: () => {
        throw new Error('never built in these tests');
      },
    },
  ],
});

function registry(): PluginRegistry {
  return PluginRegistry.fromPlugins([PLUGIN]);
}

describe('routing targets', () => {
  it('refuses a target that is neither step nor outcome', () => {
    expect(() =>
      parseFlowObject(docWith([llmStep('draft', 'hi', { then: 'nowhere' })])),
    ).toThrow(/routes to "nowhere", which is not a step or an outcome/);
  });

  it('refuses a then pointing backward', () => {
    expect(() =>
      parseFlowObject(
        docWith([
          llmStep('draft', 'hi'),
          llmStep('polish', 'more', { then: 'draft' }),
        ]),
      ),
    ).toThrow(/routes back to "draft".*forward/s);
  });

  it('refuses a switch case pointing backward', () => {
    expect(() =>
      parseFlowObject(
        docWith([
          llmStep('draft', 'hi'),
          {
            name: 'route',
            switch: '{{draft.text}}',
            cases: { again: 'draft' },
            else: 'done',
          },
        ]),
      ),
    ).toThrow(/routes back to "draft"/);
  });

  it('refuses a fall-through to a done the document does not define', () => {
    expect(() =>
      parseFlowObject(
        docWith([llmStep('draft', 'hi')], { outcomes: { handoff: {} } }),
      ),
    ).toThrow(/falls through to the outcome "done"/);
  });

  it('refuses a step no path reaches', () => {
    expect(() =>
      parseFlowObject(
        docWith([
          llmStep('draft', 'hi', { then: 'polish' }),
          llmStep('skipped', 'never'),
          llmStep('polish', 'more'),
        ]),
      ),
    ).toThrow(/step "skipped" is unreachable/);
  });

  it('refuses an outcome no path reaches', () => {
    expect(() =>
      parseFlowObject(
        docWith([llmStep('draft', 'hi')], {
          outcomes: { done: {}, stranded: {} },
        }),
      ),
    ).toThrow(/outcome "stranded" is declared but no path reaches it/);
  });
});

describe('template references', () => {
  it('refuses a reference to something that is not a step', () => {
    expect(() =>
      parseFlowObject(docWith([llmStep('draft', 'hi {{ghost.text}}')])),
    ).toThrow(/"ghost" is not "inputs" or a step/);
  });

  it('refuses a step reading its own output', () => {
    expect(() =>
      parseFlowObject(docWith([llmStep('draft', 'hi {{draft.text}}')])),
    ).toThrow(/itself — a step cannot read its own output/);
  });

  it('refuses an input field the flow does not declare', () => {
    expect(() =>
      parseFlowObject(docWith([llmStep('draft', 'hi {{inputs.nope}}')])),
    ).toThrow(/"inputs" writes "query" — never "nope"/);
  });

  it('refuses a key the producer never writes', () => {
    // An llm step writes `text` and nothing else.
    expect(() =>
      parseFlowObject(
        docWith([
          llmStep('draft', 'hi'),
          llmStep('polish', 'more {{draft.result}}'),
        ]),
      ),
    ).toThrow(/"draft" writes "text" — never "result"/);
  });

  it('holds an agent with declared output to exactly those keys', () => {
    // `output` replaces `result`; the old key is gone, not merged.
    expect(() =>
      parseFlowObject(
        docWith([
          {
            name: 'triage',
            agent: { model: MODEL, prompt: 'hi', output: { status: 'string' } },
          },
          llmStep('wrap', 'so: {{triage.result}}'),
        ]),
      ),
    ).toThrow(/"triage" writes "status" — never "result"/);
  });

  it('refuses a tool output the tool does not declare', () => {
    expect(() =>
      parseFlowObject(
        docWith([{ name: 'fetch', tool: 'log_search', with: { pattern: 'x' } }], {
          tools: {
            log_search: {
              inputs: { pattern: 'string' },
              outputs: { matches: 'string' },
            },
          },
          outcomes: { done: { hits: '{{fetch.nope}}' } },
        }),
      ),
    ).toThrow(/"fetch" writes "matches" — never "nope"/);
  });

  it('refuses a producer some path to the consumer skips', () => {
    expect(() =>
      parseFlowObject(
        docWith([
          {
            name: 'route',
            switch: '{{inputs.query}}',
            cases: { skip: 'wrap' },
            else: 'work',
          },
          llmStep('work', 'draft an answer to {{inputs.query}}'),
          llmStep('wrap', 'polish {{work.text}}'),
        ]),
      ),
    ).toThrow(/reaches "wrap" without running "work"/);
  });

  it('accepts a producer that runs on every path', () => {
    expect(() =>
      parseFlowObject(
        docWith([
          llmStep('work', 'draft an answer to {{inputs.query}}'),
          llmStep('wrap', 'polish {{work.text}}'),
        ]),
      ),
    ).not.toThrow();
  });

  it('reports every problem at once', () => {
    let message = '';
    try {
      parseFlowObject(
        docWith([llmStep('draft', 'hi {{ghost.a}}')], {
          outcomes: { done: { out: '{{draft.nope}}' } },
        }),
      );
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toMatch(/"ghost" is not "inputs" or a step/);
    expect(message).toMatch(/never "nope"/);
  });
});

describe('transform outputs', () => {
  const withTransforms = (transforms: unknown[]) =>
    docWith(
      [
        {
          name: 'triage',
          agent: { model: MODEL, prompt: 'hi {{inputs.query}}', transforms },
        },
        {
          name: 'route',
          switch: '{{triage.transform_status}}',
          cases: { rejected: 'flagged' },
          else: 'done',
        },
      ],
      { outcomes: { done: {}, flagged: {} } },
    );

  it('an agent with transforms also writes the transform keys', () => {
    expect(() =>
      parseFlowObject(
        withTransforms([{ use: 'SecretScrub', patterns: ['x'] }]),
        registry(),
      ),
    ).not.toThrow();
  });

  it('an agent without transforms does not', () => {
    expect(() => parseFlowObject(withTransforms([]), registry())).toThrow(
      /never "transform_status"/,
    );
  });
});

describe('plugin component types', () => {
  const useDoc = (config: Record<string, unknown>, use = 'RegexRewrite') =>
    docWith([{ name: 'scrub', use, with: config }]);

  it('refuses a type no loaded plugin provides', () => {
    expect(() => parseFlowObject(useDoc({}))).toThrow(
      /no loaded plugin provides/,
    );
  });

  it('refuses a type a plugin provides as another kind', () => {
    expect(() =>
      parseFlowObject(useDoc({}, 'SecretScrub'), registry()),
    ).toThrow(/as a transform rather than a node/);
  });

  it('lets the plugin validate its own config', () => {
    expect(() => parseFlowObject(useDoc({}), registry())).toThrow(
      /RegexRewrite needs a "pattern"/,
    );
  });

  it('validates references against the outputs the manifest declares', () => {
    expect(() =>
      parseFlowObject(
        docWith([{ name: 'scrub', use: 'RegexRewrite', with: { pattern: 'x' } }], {
          outcomes: { done: { out: '{{scrub.nope}}' } },
        }),
        registry(),
      ),
    ).toThrow(/"scrub" writes "text" — never "nope"/);
  });

  it('leaves references into an undeclared output set alone', () => {
    expect(() =>
      parseFlowObject(
        docWith([{ name: 'scrub', use: 'Opaque', with: {} }], {
          outcomes: { done: { out: '{{scrub.anything}}' } },
        }),
        registry(),
      ),
    ).not.toThrow();
  });
});

describe('providers', () => {
  const providerDoc = (model: Record<string, unknown>) =>
    docWith([{ name: 'draft', llm: { model, prompt: 'hi' } }]);

  it('refuses a provider that is neither builtin nor loaded', () => {
    expect(() =>
      parseFlowObject(providerDoc({ provider: 'anthropic', model: 'x' })),
    ).toThrow(/Builtin providers: openai, openai-compatible, ollama, vllm/);
  });

  it('refuses a provider type a plugin provides as another kind', () => {
    expect(() =>
      parseFlowObject(
        providerDoc({ provider: 'RegexRewrite', model: 'x' }),
        registry(),
      ),
    ).toThrow(/as a node rather than a provider/);
  });

  it('accepts a plugin provider, extra fields and all', () => {
    expect(() =>
      parseFlowObject(
        providerDoc({ provider: 'EchoProvider', model: 'echo-1', voice: 'low' }),
        registry(),
      ),
    ).not.toThrow();
  });

  it('lets the plugin refuse its own config', () => {
    expect(() =>
      parseFlowObject(
        providerDoc({ provider: 'EchoProvider', model: 'echo-1', voice: 3 }),
        registry(),
      ),
    ).toThrow(/"voice" must be a string/);
  });
});

describe('requires', () => {
  const requiresDoc = (range: string) =>
    docWith([llmStep('draft', 'hi')], { requires: { SecretScrub: range } });

  it('passes a pin the loaded plugin satisfies', () => {
    expect(() => parseFlowObject(requiresDoc('^1.0'), registry())).not.toThrow();
  });

  it('refuses a pin the loaded plugin does not satisfy', () => {
    expect(() => parseFlowObject(requiresDoc('^2.0'), registry())).toThrow(
      /pinned to "\^2.0", but the loaded plugin provides 1.2.3/,
    );
  });

  it('refuses a pin on a type nothing provides', () => {
    expect(() => parseFlowObject(requiresDoc('^1.0'))).toThrow(
      /no loaded plugin provides it/,
    );
  });
});

describe('satisfies', () => {
  it('matches an exact version on all three parts', () => {
    expect(satisfies('1.2.3', '1.2.3')).toBe(true);
    expect(satisfies('1.2.4', '1.2.3')).toBe(false);
  });

  it('caret pins the major', () => {
    expect(satisfies('1.9.0', '^1.2')).toBe(true);
    expect(satisfies('2.0.0', '^1.2')).toBe(false);
    expect(satisfies('1.1.0', '^1.2')).toBe(false);
  });

  it('tilde pins major and minor', () => {
    expect(satisfies('1.2.9', '~1.2.3')).toBe(true);
    expect(satisfies('1.3.0', '~1.2.3')).toBe(false);
  });

  it('>= is a floor', () => {
    expect(satisfies('2.0.0', '>=1.2')).toBe(true);
    expect(satisfies('1.1.9', '>=1.2')).toBe(false);
  });

  it('treats missing parts as zero and garbage as unsatisfied', () => {
    expect(satisfies('1.0.0', '1')).toBe(true);
    expect(satisfies('1.0.0', 'latest')).toBe(false);
  });
});
