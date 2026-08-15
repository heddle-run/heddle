import { describe, it, expect } from 'vitest';
import { parseFlowObject, parseFlowYaml } from '../parser.js';
import { PluginRegistry } from '../../plugin/registry.js';
import { definePlugin } from '../../plugin/types.js';

/** The smallest document that parses: one agent, one input. */
function minimalDoc(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    weave: 1,
    name: 'triage-bot',
    inputs: { query: 'string' },
    agent: {
      model: { provider: 'openai', model: 'gpt-4o' },
      prompt: 'Answer: {{inputs.query}}',
    },
    ...overrides,
  };
}

const MODEL = { provider: 'openai', model: 'gpt-4o' };

describe('the weave version key', () => {
  it('refuses a document without one', () => {
    const doc = minimalDoc();
    delete doc.weave;
    expect(() => parseFlowObject(doc)).toThrow(/not a Weave document/);
  });

  it('refuses a version this heddle does not read', () => {
    expect(() => parseFlowObject(minimalDoc({ weave: 2 }))).toThrow(
      /reads version 1/,
    );
  });

  it('wants the integer 1, not the string "1"', () => {
    expect(() => parseFlowObject(minimalDoc({ weave: '1' }))).toThrow(
      /reads version 1/,
    );
  });
});

describe('parsing a full flow', () => {
  const yaml = `
weave: 1
name: oncall-triage
description: Triage an alert.
inputs:
  alert: string
  service:
    type: string
    description: The service the alert names.
models:
  fast:
    provider: openai
    model: gpt-4o-mini
    params: { temperature: 0 }
tools:
  log_search:
    description: Search recent log lines.
    inputs:
      pattern: string
      limit: { type: integer, default: 5 }
    outputs:
      matches: string
      count: integer
steps:
  - name: triage
    agent:
      model: fast
      prompt: 'Work the alert {{inputs.alert}} for {{inputs.service}}.'
      tools: [log_search]
      output:
        status: string
        note: string
  - name: route
    switch: '{{triage.status}}'
    cases:
      rejected: handoff
    else: done
outcomes:
  done:
    note: '{{triage.note}}'
  handoff:
    note: '{{triage.note}}'
    reason: needs-human
meta:
  anything: goes
`;

  const flow = parseFlowYaml(yaml);

  it('carries name, description and inputs', () => {
    expect(flow.name).toBe('oncall-triage');
    expect(flow.description).toBe('Triage an alert.');
    // Shorthand and longhand normalize to the same field schema.
    expect(flow.inputs.alert).toEqual({ type: 'string' });
    expect(flow.inputs.service.description).toBe(
      'The service the alert names.',
    );
  });

  it('resolves a model name to its declared config', () => {
    const step = flow.steps[0];
    if (step.kind !== 'agent') throw new Error('expected an agent step');
    expect(step.agent.model.model).toBe('gpt-4o-mini');
    expect(step.agent.model.params).toEqual({ temperature: 0 });
  });

  it('embeds the declared tool, defaults included', () => {
    const step = flow.steps[0];
    if (step.kind !== 'agent') throw new Error('expected an agent step');
    expect(step.agent.tools).toHaveLength(1);
    expect(step.agent.tools[0].name).toBe('log_search');
    expect(step.agent.tools[0].inputs.limit.default).toBe(5);
  });

  it('keeps the structured output schema', () => {
    const step = flow.steps[0];
    if (step.kind !== 'agent') throw new Error('expected an agent step');
    expect(Object.keys(step.agent.output ?? {})).toEqual(['status', 'note']);
  });

  it('parses the switch as one reference, cases and else', () => {
    const step = flow.steps[1];
    if (step.kind !== 'switch') throw new Error('expected a switch step');
    expect(step.on).toBe('triage.status');
    expect(step.cases).toEqual({ rejected: 'handoff' });
    expect(step.else).toBe('done');
  });

  it('parses outcomes with their payloads', () => {
    expect(flow.outcomes.map((outcome) => outcome.name)).toEqual([
      'done',
      'handoff',
    ]);
    expect(flow.outcomes[1].payload).toEqual({
      note: '{{triage.note}}',
      reason: 'needs-human',
    });
  });

  it('carries meta through untouched', () => {
    expect(flow.meta).toEqual({ anything: 'goes' });
  });
});

describe('the single-agent sugar', () => {
  it('becomes a one-step flow named after the document', () => {
    const flow = parseFlowObject(minimalDoc());
    expect(flow.steps).toHaveLength(1);
    expect(flow.steps[0].kind).toBe('agent');
    // Hyphens are legal in a flow name but not a step name.
    expect(flow.steps[0].name).toBe('triage_bot');
    expect(flow.outcomes).toEqual([{ name: 'done' }]);
  });

  it('refuses a document with both agent and steps', () => {
    expect(() =>
      parseFlowObject(minimalDoc({ steps: [] })),
    ).toThrow(/not both/);
  });

  it('refuses a document with neither', () => {
    const doc = minimalDoc();
    delete doc.agent;
    expect(() => parseFlowObject(doc)).toThrow(/needs "agent" or "steps"/);
  });

  it('refuses an empty steps list', () => {
    const doc = minimalDoc({ steps: [] });
    delete doc.agent;
    expect(() => parseFlowObject(doc)).toThrow(/non-empty list/);
  });
});

describe('unknown keys are refused everywhere but meta', () => {
  it('at the top level', () => {
    expect(() => parseFlowObject(minimalDoc({ nodes: [] }))).toThrow(
      /the document: unknown key "nodes"/,
    );
  });

  it('on a step', () => {
    const doc = minimalDoc({
      steps: [
        {
          name: 'draft',
          llm: { model: MODEL, prompt: 'hi {{inputs.query}}' },
          retries: 3,
        },
      ],
    });
    delete doc.agent;
    expect(() => parseFlowObject(doc)).toThrow(/unknown key "retries"/);
  });

  it('inside an agent', () => {
    expect(() =>
      parseFlowObject(
        minimalDoc({
          agent: { model: MODEL, prompt: 'hi', memory: true },
        }),
      ),
    ).toThrow(/unknown key "memory"/);
  });

  it('among generation parameters', () => {
    expect(() =>
      parseFlowObject(
        minimalDoc({
          agent: {
            model: { ...MODEL, params: { seed: 7 } },
            prompt: 'hi',
          },
        }),
      ),
    ).toThrow(/unknown parameter "seed"/);
  });

  it('on a builtin provider config', () => {
    expect(() =>
      parseFlowObject(
        minimalDoc({
          agent: { model: { ...MODEL, organization: 'acme' }, prompt: 'hi' },
        }),
      ),
    ).toThrow(/only meaningful to a plugin provider/);
  });
});

describe('names and namespaces', () => {
  it('requires a flow name', () => {
    expect(() => parseFlowObject(minimalDoc({ name: 'Bad Name' }))).toThrow(
      /"name" is required/,
    );
  });

  it('holds step names to the identifier shape', () => {
    const doc = minimalDoc({
      steps: [{ name: 'Bad-Name', llm: { model: MODEL, prompt: 'hi' } }],
    });
    delete doc.agent;
    expect(() => parseFlowObject(doc)).toThrow(/"name" is required/);
  });

  it('refuses a name declared twice across steps and outcomes', () => {
    const doc = minimalDoc({
      steps: [
        { name: 'draft', llm: { model: MODEL, prompt: 'a' } },
        { name: 'draft', llm: { model: MODEL, prompt: 'b' } },
      ],
    });
    delete doc.agent;
    expect(() => parseFlowObject(doc)).toThrow(/"draft" is declared twice/);
  });

  it('refuses a step taking the implicit outcome name', () => {
    // With no `outcomes` block the document still owns a `done` outcome.
    const doc = minimalDoc({
      steps: [{ name: 'done', llm: { model: MODEL, prompt: 'hi' } }],
    });
    delete doc.agent;
    expect(() => parseFlowObject(doc)).toThrow(/"done" is declared twice/);
  });

  it('reserves the inputs namespace', () => {
    const doc = minimalDoc({
      steps: [{ name: 'inputs', llm: { model: MODEL, prompt: 'hi' } }],
    });
    delete doc.agent;
    expect(() => parseFlowObject(doc)).toThrow(/reserved/);
  });
});

describe('models and tools resolve against the document', () => {
  it('refuses a model name the document does not declare', () => {
    expect(() =>
      parseFlowObject(
        minimalDoc({
          models: { fast: MODEL },
          agent: { model: 'slow', prompt: 'hi' },
        }),
      ),
    ).toThrow(/"slow" is not in "models".*fast/s);
  });

  it('refuses an agent tool the document does not declare', () => {
    expect(() =>
      parseFlowObject(
        minimalDoc({ agent: { model: MODEL, prompt: 'hi', tools: ['ghost'] } }),
      ),
    ).toThrow(/"ghost" is not in "tools"/);
  });

  it('refuses a tool step naming an undeclared tool', () => {
    const doc = minimalDoc({
      steps: [{ name: 'fetch', tool: 'ghost', with: {} }],
    });
    delete doc.agent;
    expect(() => parseFlowObject(doc)).toThrow(/"ghost" is not in "tools"/);
  });
});

describe('tool step arguments', () => {
  const toolsDoc = (args: Record<string, unknown>) => {
    const doc = minimalDoc({
      tools: {
        log_search: {
          inputs: {
            pattern: 'string',
            limit: { type: 'integer', default: 5 },
          },
          outputs: { matches: 'string' },
        },
      },
      steps: [{ name: 'fetch', tool: 'log_search', with: args }],
    });
    delete doc.agent;
    return doc;
  };

  it('accepts a call that omits only defaulted inputs', () => {
    const flow = parseFlowObject(toolsDoc({ pattern: '{{inputs.query}}' }));
    expect(flow.steps[0].kind).toBe('tool');
  });

  it('refuses an argument the tool does not take', () => {
    expect(() =>
      parseFlowObject(toolsDoc({ pattern: 'x', depth: 3 })),
    ).toThrow(/takes no input "depth"/);
  });

  it('refuses to omit an input with no default', () => {
    expect(() => parseFlowObject(toolsDoc({ limit: 2 }))).toThrow(
      /requires "pattern"/,
    );
  });
});

describe('switch shape', () => {
  const switchDoc = (route: Record<string, unknown>) => {
    const doc = minimalDoc({
      steps: [
        { name: 'draft', llm: { model: MODEL, prompt: 'hi {{inputs.query}}' } },
        { name: 'route', switch: '{{draft.text}}', cases: {}, ...route },
      ],
    });
    delete doc.agent;
    return doc;
  };

  it('requires else — there is no implicit default', () => {
    expect(() => parseFlowObject(switchDoc({}))).toThrow(
      /"else" is required/,
    );
  });

  it('refuses then on a switch', () => {
    expect(() =>
      parseFlowObject(switchDoc({ else: 'done', then: 'done' })),
    ).toThrow(/"then" does not apply/);
  });

  it('wants the expression to be exactly one reference', () => {
    expect(() =>
      parseFlowObject(
        switchDoc({ switch: '{{draft.text}} extra', else: 'done' }),
      ),
    ).toThrow(/exactly one reference/);
  });
});

describe('templates and payloads', () => {
  it('refuses a placeholder that is not a reference', () => {
    expect(() =>
      parseFlowObject(minimalDoc({ agent: { model: MODEL, prompt: 'hi {{query}}' } })),
    ).toThrow(/is not a reference/);
  });

  it('reserves the outcome key in payloads', () => {
    expect(() =>
      parseFlowObject(minimalDoc({ outcomes: { done: { outcome: 'x' } } })),
    ).toThrow(/the key heddle writes/);
  });

  it('refuses an empty outcomes block', () => {
    expect(() => parseFlowObject(minimalDoc({ outcomes: {} }))).toThrow(
      /at least one outcome, or be omitted/,
    );
  });
});

describe('agent extras', () => {
  it('refuses an empty output schema', () => {
    expect(() =>
      parseFlowObject(
        minimalDoc({ agent: { model: MODEL, prompt: 'hi', output: {} } }),
      ),
    ).toThrow(/at least one field/);
  });

  it('holds max_tool_rounds to a whole number of 1 or more', () => {
    expect(() =>
      parseFlowObject(
        minimalDoc({
          agent: { model: MODEL, prompt: 'hi', max_tool_rounds: 0 },
        }),
      ),
    ).toThrow(/1 or more/);
  });
});

describe('a transform on an agent', () => {
  const SCRUBBER = definePlugin({
    name: 'test-scrubber',
    version: '1.0.0',
    transforms: [
      {
        componentType: 'SecretScrub',
        createTransform: () => ({ apply: () => ({ action: 'pass' as const }) }),
      },
    ],
  });

  it('keeps its own keys as config, use excepted', () => {
    const flow = parseFlowObject(
      minimalDoc({
        agent: {
          model: MODEL,
          prompt: 'hi {{inputs.query}}',
          transforms: [
            { use: 'SecretScrub', phase: 'both', patterns: ['secret'] },
          ],
        },
      }),
      PluginRegistry.fromPlugins([SCRUBBER]),
    );

    const step = flow.steps[0];
    if (step.kind !== 'agent') throw new Error('expected an agent step');
    expect(step.agent.transforms).toEqual([
      { use: 'SecretScrub', config: { phase: 'both', patterns: ['secret'] } },
    ]);
  });
});
