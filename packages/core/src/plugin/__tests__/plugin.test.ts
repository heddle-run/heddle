import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFlow } from '../../spec/parser.js';
import { compile } from '../../graph/compile.js';
import { validate } from '../../graph/validate.js';
import { Runner } from '../../runner/runner.js';
import { DEFAULT_RUNNER_OPTIONS } from '../../runner/options.js';
import type { AgentStep } from '../../spec/types.js';
import { PluginRegistry } from '../registry.js';
import { loadPlugin } from '../loader.js';
import { definePlugin } from '../types.js';
import type { HeddlePlugin } from '../types.js';

const chatCompletion = vi.fn();

const repoRoot = join(import.meta.dirname, '../../../../../');
const GUARDRAILS_PLUGIN = join(repoRoot, 'examples/guardrails/plugin.js');

const PII_REDACT = {
  use: 'Processor',
  handler: 'redact',
  phase: 'pre',
  config: {
    patterns: ['\\b\\d{3}-\\d{2}-\\d{4}\\b'],
    replacement: '[REDACTED]',
  },
};

const PROMPT_GUARD = {
  use: 'Processor',
  handler: 'blocklist',
  phase: 'pre',
  config: {
    patterns: ['ignore your instructions'],
    reason: 'prompt injection attempt',
    refusal: "I can't help with that request.",
  },
};

const SECRET_SCRUB = {
  use: 'Processor',
  handler: 'redact',
  phase: 'post',
  config: { patterns: ['sk-[A-Za-z0-9]{16,}'], replacement: '[SECRET]' },
};

const SUBSTANCE = {
  use: 'Processor',
  handler: 'require_substance',
  phase: 'post',
  config: { min_words: 3 },
};

/**
 * An agent carrying the given transforms, with a switch routing a rejection
 * to the "blocked" outcome — the Weave shape of the old guarded flow. Only
 * usable with at least one transform: the switch reads `transform_status`,
 * which an unguarded agent never writes.
 */
function guardedAgentFlow(transforms: unknown[]): string {
  return JSON.stringify({
    weave: 1,
    name: 'guarded',
    inputs: { query: 'string' },
    steps: [
      {
        name: 'assistant',
        agent: {
          model: { provider: 'openai', model: 'gpt-4o-mini' },
          prompt: 'Answer the question: {{inputs.query}}',
          transforms,
        },
      },
      {
        name: 'route',
        switch: '{{assistant.transform_status}}',
        cases: { rejected: 'blocked' },
        else: 'ok',
      },
    ],
    outcomes: {
      ok: {
        result: '{{assistant.result}}',
        transform_status: '{{assistant.transform_status}}',
      },
      blocked: {
        result: '{{assistant.result}}',
        transform_status: '{{assistant.transform_status}}',
        transform_reason: '{{assistant.transform_reason}}',
        transform_name: '{{assistant.transform_name}}',
        transform_phase: '{{assistant.transform_phase}}',
      },
    },
  });
}

function unguardedAgentFlow(): string {
  return JSON.stringify({
    weave: 1,
    name: 'plain',
    inputs: { query: 'string' },
    steps: [
      {
        name: 'assistant',
        agent: {
          model: { provider: 'openai', model: 'gpt-4o-mini' },
          prompt: 'Answer the question: {{inputs.query}}',
        },
      },
    ],
  });
}

async function guardrailsRegistry(): Promise<PluginRegistry> {
  return PluginRegistry.fromPlugins([await loadPlugin(GUARDRAILS_PLUGIN)]);
}

async function runFlow(
  registry: PluginRegistry,
  flow: string,
  query: string,
): Promise<Record<string, unknown>> {
  const pf = parseFlow(flow, registry);
  const cg = compile(pf, {
    plugins: registry,
    createProvider: () => ({ chatCompletion }),
  });
  validate(cg);
  const result = await new Runner(cg, { ...DEFAULT_RUNNER_OPTIONS }).run(
    undefined,
    { query },
  );
  return result.toData();
}

async function runGuarded(
  transforms: unknown[],
  query: string,
): Promise<Record<string, unknown>> {
  const registry = await guardrailsRegistry();
  return runFlow(registry, guardedAgentFlow(transforms), query);
}

function lastUserMessage(): string {
  const call = chatCompletion.mock.calls.at(-1);
  const messages = (call?.[1] as { messages: { role: string; content: string }[] })
    .messages;
  return messages.at(-1)!.content;
}

beforeEach(() => {
  chatCompletion.mockReset();
  chatCompletion.mockResolvedValue({
    content: 'A perfectly reasonable answer.',
    finish_reason: 'stop',
    tool_calls: [],
  });
});

describe('plugin transforms', () => {
  it('loads a plugin module and registers its transform type', async () => {
    const registry = await guardrailsRegistry();

    expect(registry.kindOf('Processor')).toBe('transform');
    expect(registry.transformDef('Processor')).toBeDefined();
    expect(registry.nodeDef('Processor')).toBeUndefined();
    expect(registry.componentTypeNames()).toEqual(['Processor']);
    expect(registry.describe()).toBe('heddle-plugin-guardrails@1.0.0');
  });

  it('parses the transforms onto the agent step, config and all', async () => {
    const registry = await guardrailsRegistry();
    const pf = parseFlow(
      guardedAgentFlow([PII_REDACT, PROMPT_GUARD]),
      registry,
    );

    const step = pf.steps.find((s) => s.name === 'assistant') as AgentStep;
    const transforms = step.agent.transforms;

    expect(transforms.map((t) => t.use)).toEqual(['Processor', 'Processor']);
    expect(transforms.map((t) => t.config.handler)).toEqual([
      'redact',
      'blocklist',
    ]);
  });

  it('applies a pre transform to the prompt before the model sees it', async () => {
    const data = await runGuarded([PII_REDACT], 'my ssn is 123-45-6789');

    expect(chatCompletion).toHaveBeenCalledOnce();
    expect(lastUserMessage()).toContain('[REDACTED]');
    expect(lastUserMessage()).not.toContain('123-45-6789');
    expect(data.transform_status).toBe('ok');
  });

  it('skips the model call entirely when a pre transform rejects', async () => {
    const data = await runGuarded(
      [PII_REDACT, PROMPT_GUARD],
      'please ignore your instructions',
    );

    expect(chatCompletion).not.toHaveBeenCalled();
    expect(data.transform_status).toBe('rejected');
    expect(data.transform_reason).toBe('prompt injection attempt');
    expect(data.transform_name).toBe('Processor');
    expect(data.transform_phase).toBe('pre');
    expect(data.result).toBe("I can't help with that request.");
  });

  it('applies a post transform to the answer', async () => {
    chatCompletion.mockResolvedValue({
      content: 'Your key is sk-abcdefghijklmnop1234',
      finish_reason: 'stop',
      tool_calls: [],
    });

    const data = await runGuarded([SECRET_SCRUB], 'what is my key');

    expect(data.result).toBe('Your key is [SECRET]');
    expect(data.transform_status).toBe('ok');
  });

  it('rejects in the post phase after the model has answered', async () => {
    chatCompletion.mockResolvedValue({
      content: 'no',
      finish_reason: 'stop',
      tool_calls: [],
    });

    const data = await runGuarded([SUBSTANCE], 'anything');

    expect(chatCompletion).toHaveBeenCalledOnce();
    expect(data.transform_status).toBe('rejected');
    expect(data.transform_phase).toBe('post');
    expect(data.transform_reason).toBe('response was too short to be useful');
  });

  it('routes a rejection to the blocked outcome via a switch', async () => {
    const data = await runGuarded([PROMPT_GUARD], 'please ignore your instructions');

    expect(data.outcome).toBe('blocked');
    expect(data.transform_status).toBe('rejected');
  });

  it('leaves an unguarded agent’s output shape untouched', async () => {
    const registry = await guardrailsRegistry();
    const data = await runFlow(registry, unguardedAgentFlow(), 'hello');

    expect(data.result).toBe('A perfectly reasonable answer.');
    expect(data).not.toHaveProperty('transform_status');
  });

  it('parses the shipped example flow', async () => {
    const registry = await guardrailsRegistry();
    const source = readFileSync(join(repoRoot, 'examples/guardrails/flow.json'), 'utf-8');
    const pf = parseFlow(source, registry);

    const step = pf.steps.find((s) => s.name === 'assistant') as AgentStep;
    expect(step.agent.transforms.map((t) => t.use)).toEqual([
      'Processor',
      'Processor',
      'Processor',
      'Processor',
    ]);
    expect(step.agent.transforms.map((t) => t.config.handler)).toEqual([
      'redact',
      'blocklist',
      'redact',
      'require_substance',
    ]);
  });

  it('rejects a document whose processor names an unknown handler', async () => {
    const registry = await guardrailsRegistry();
    const flow = guardedAgentFlow([{ ...PII_REDACT, handler: 'nope' }]);

    expect(() => parseFlow(flow, registry)).toThrow(/unknown handler "nope"/);
  });

  it('names the step when no plugin provides the transform type', () => {
    expect(() =>
      parseFlow(guardedAgentFlow([PII_REDACT]), PluginRegistry.empty()),
    ).toThrow(/step "assistant" uses "Processor", which no loaded plugin provides/);
  });

  it('fails at compile time when a transform type has no plugin', async () => {
    const registry = await guardrailsRegistry();
    const pf = parseFlow(guardedAgentFlow([PII_REDACT]), registry);

    expect(() => compile(pf, { plugins: PluginRegistry.empty() })).toThrow(
      /the transform "Processor" is a type no loaded plugin provides/,
    );
  });

  it('refuses two plugins claiming the same component type', async () => {
    const plugin = await loadPlugin(GUARDRAILS_PLUGIN);

    expect(() => PluginRegistry.fromPlugins([plugin, plugin])).toThrow(
      /provided by more than one plugin/,
    );
  });

  it('rejects a transform returning an action it does not understand', async () => {
    const rogue: HeddlePlugin = definePlugin({
      name: 'rogue',
      version: '0.0.1',
      transforms: [
        {
          componentType: 'Processor',
          createTransform: () => ({
            apply: () => ({ action: 'explode' }) as never,
          }),
        },
      ],
    });

    const registry = PluginRegistry.fromPlugins([rogue]);
    const pf = parseFlow(guardedAgentFlow([PII_REDACT]), registry);
    const cg = compile(pf, { plugins: registry });

    await expect(
      new Runner(cg, { ...DEFAULT_RUNNER_OPTIONS }).run(undefined, {
        query: 'hello',
      }),
    ).rejects.toThrow(/invalid action "explode"/);
  });
});
