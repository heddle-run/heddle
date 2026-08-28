import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PluginRegistry } from '../registry.js';
import { loadRemotePlugin } from '../remote-loader.js';
import { validateManifest } from '../manifest.js';
import { withRuntime } from '../runtime-source.js';
import { compile } from '../../graph/compile.js';
import { validate } from '../../graph/validate.js';
import { parseFlow } from '../../spec/parser.js';
import { Runner } from '../../runner/runner.js';
import { DEFAULT_RUNNER_OPTIONS } from '../../runner/options.js';
import { LLMExecutor } from '../../node/llm.js';
import { State } from '../../state/state.js';
import { providerFor } from '../../llm/provider.js';
import type { Dependencies } from '../../node/types.js';
import type { ChatChunk, ChatRequest, ChatResponse, Provider } from '../../llm/types.js';
import type { LlmStep, ModelSpec } from '../../spec/types.js';
import type { Event } from '../../runner/events.js';
import type { HeddlePlugin, PluginComponent } from '../types.js';

let scratch: string;
const open: PluginRegistry[] = [];

let asked: ChatRequest[] = [];
let configs: PluginComponent[] = [];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'heddle-provider-'));
  asked = [];
  configs = [];
});

afterEach(() => {
  while (open.length) open.pop()!.dispose();
  rmSync(scratch, { recursive: true, force: true });
});

const builtinCalls: ModelSpec[] = [];
const builtinProvider = (config: ModelSpec): Provider => {
  builtinCalls.push(config);
  return {
    chatCompletion: async () => ({ content: 'from the builtin', finish_reason: 'stop' }),
  };
};

beforeEach(() => {
  builtinCalls.length = 0;
});

function providerPlugin(
  componentType: string,
  answer: (request: ChatRequest) => ChatResponse = () => ({
    content: 'from the plugin',
    finish_reason: 'stop',
  }),
): PluginRegistry {
  return PluginRegistry.fromPlugins([
    {
      name: 'anthropic-plugin',
      version: '1.0.0',
      providers: [
        {
          componentType,
          createProvider: (config) => {
            configs.push(config);
            return {
              chatCompletion: async (_signal, request) => {
                asked.push(request);
                return answer(request);
              },
            };
          },
        },
      ],
    },
  ]);
}

function flowWithLlmStep(model: Record<string, unknown>): string {
  return JSON.stringify({
    weave: 1,
    name: 'provider-flow',
    inputs: { text: 'string' },
    steps: [{ name: 'p', llm: { model, prompt: 'say something' } }],
  });
}

function pluginModel(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { provider: 'AnthropicConfig', model: 'claude-sonnet-4-5', ...extra };
}

function pluginModelSpec(): ModelSpec {
  return { provider: 'AnthropicConfig', model: 'claude-sonnet-4-5', extra: {} };
}

async function runFlow(
  registry: PluginRegistry,
  flow: string,
  deps: Partial<Dependencies> = {},
): Promise<Record<string, unknown>> {
  open.push(registry);
  const graph = compile(parseFlow(flow, registry), {
    plugins: registry,
    createProvider: builtinProvider,
    ...deps,
  });
  validate(graph);
  const state = await new Runner(graph, {
    ...DEFAULT_RUNNER_OPTIONS,
    verbose: false,
  }).run(undefined, { text: 'hello' });
  return state.toData() as Record<string, unknown>;
}

describe('a plugin provider answering a document', () => {
  it('answers an llm step whose model names it', async () => {
    const registry = providerPlugin('AnthropicConfig');

    const state = await runFlow(registry, flowWithLlmStep(pluginModel()));

    expect(state.text).toBe('from the plugin');
    expect(asked).toHaveLength(1);
    expect(asked[0].model).toBe('claude-sonnet-4-5');
    expect(builtinCalls).toHaveLength(0);
  });

  it('hands over the model entry as the document wrote it, extra fields and all', async () => {
    const registry = providerPlugin('AnthropicConfig');

    await runFlow(
      registry,
      flowWithLlmStep(
        pluginModel({ api_key: '$ANTHROPIC_KEY', anthropic_version: '2023-06-01' }),
      ),
    );

    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      componentType: 'AnthropicConfig',
      model: 'claude-sonnet-4-5',
      anthropic_version: '2023-06-01',
    });
    expect(configs[0].api_key).toBe('$ANTHROPIC_KEY');
  });

  it('reads the model params into the request, as a builtin does', async () => {
    const registry = providerPlugin('AnthropicConfig');

    await runFlow(
      registry,
      flowWithLlmStep(pluginModel({ params: { temperature: 0.2, max_tokens: 64 } })),
    );

    expect(asked[0]).toMatchObject({ temperature: 0.2, maxTokens: 64 });
  });

  it('builds the provider once for a step executed twice', async () => {
    const registry = providerPlugin('AnthropicConfig');
    open.push(registry);

    const step: LlmStep = {
      kind: 'llm',
      name: 'p',
      model: pluginModelSpec(),
      prompt: 'say something',
    };

    const executor = new LLMExecutor(step, {
      plugins: registry,
      createProvider: builtinProvider,
    });
    await executor.execute(undefined, new State({ q: 'a' }));
    await executor.execute(undefined, new State({ q: 'b' }));

    expect(configs).toHaveLength(1);
    expect(asked).toHaveLength(2);
  });

  it('serves a plugin component’s own callModel through the same seam', async () => {
    const registry = providerPlugin('AnthropicConfig');
    registry.add({
      name: 'judge-plugin',
      version: '1.0.0',
      nodes: [
        {
          componentType: 'JudgeNode',
          createExecutor: () => ({
            execute: async (_input, ctx) => {
              const resp = await ctx.callModel({
                messages: [{ role: 'user', content: 'score this' }],
              });
              return { output: { verdict: resp.content } };
            },
          }),
        },
      ],
    } as HeddlePlugin);

    const flow = JSON.stringify({
      weave: 1,
      name: 'judge-flow',
      inputs: { text: 'string' },
      steps: [{ name: 'p', use: 'JudgeNode', with: { model: pluginModel() } }],
    });

    const state = await runFlow(registry, flow);

    expect(state.verdict).toBe('from the plugin');
    expect(builtinCalls).toHaveLength(0);
  });
});

describe('what a provider may not take', () => {
  it('sends a builtin provider to the builtin path even with plugins loaded', () => {
    const registry = providerPlugin('AnthropicConfig');
    open.push(registry);

    const provider = providerFor(
      { provider: 'openai', model: 'gpt-4o-mini', extra: {} },
      { plugins: registry, createProvider: builtinProvider },
    );

    expect(builtinCalls).toHaveLength(1);
    expect(configs).toHaveLength(0);
    expect(provider).toBeDefined();
  });

  it('never offers a builtin provider to the registry at all', () => {
    const registry = providerPlugin('AnthropicConfig');
    open.push(registry);
    const consulted: string[] = [];
    const spy = new Proxy(registry, {
      get(target, prop, receiver) {
        if (prop === 'providerDef' || prop === 'kindOf') {
          return (type: string) => {
            consulted.push(type);
            return (Reflect.get(target, prop, receiver) as (t: string) => unknown).call(target, type);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    providerFor(
      { provider: 'openai', model: 'gpt-4o-mini', extra: {} },
      { plugins: spy, createProvider: builtinProvider },
    );
    expect(consulted).toEqual([]);
  });

  it('refuses a plugin transform written as a provider, naming its kind', () => {
    const registry = PluginRegistry.fromPlugins([
      {
        name: 'guard-plugin',
        version: '1.0.0',
        transforms: [
          {
            componentType: 'Guard',
            createTransform: () => ({ apply: () => ({ action: 'pass' as const }) }),
          },
        ],
      },
    ]);
    open.push(registry);

    expect(() =>
      providerFor(
        { provider: 'Guard', model: 'x', extra: {} },
        { plugins: registry, createProvider: builtinProvider },
      ),
    ).toThrow(/provided by a plugin as a transform rather than a provider/);
  });

  it('names the loaded plugins for a provider nothing provides', () => {
    const registry = providerPlugin('AnthropicConfig');
    open.push(registry);

    expect(() =>
      providerFor(
        { provider: 'BedrockConfig', model: 'x', extra: {} },
        { plugins: registry, createProvider: builtinProvider },
      ),
    ).toThrow(/unsupported provider "BedrockConfig"[\s\S]*anthropic-plugin@1\.0\.0/);
  });

  it('does not let an embedder’s factory shadow a provider plugin', () => {
    const registry = providerPlugin('AnthropicConfig');
    open.push(registry);

    providerFor(pluginModelSpec(), {
      plugins: registry,
      createProvider: builtinProvider,
    });

    expect(configs).toHaveLength(1);
    expect(builtinCalls).toHaveLength(0);
  });
});

describe('a document naming a plugin provider', () => {
  it('parses, keeping the extra fields on the model spec', () => {
    const registry = providerPlugin('AnthropicConfig');
    open.push(registry);

    const flow = parseFlow(
      flowWithLlmStep(pluginModel({ anthropic_version: '2023-06-01' })),
      registry,
    );
    const step = flow.steps.find((s) => s.name === 'p') as LlmStep;

    expect(step.model.provider).toBe('AnthropicConfig');
    expect(step.model.model).toBe('claude-sonnet-4-5');
    expect(step.model.extra).toEqual({ anthropic_version: '2023-06-01' });
  });

  it('still refuses a builtin model entry missing its model id', () => {
    expect(() =>
      parseFlow(flowWithLlmStep({ provider: 'openai' })),
    ).toThrow();
  });

  it('still refuses an object that names no provider at all', () => {
    expect(() => parseFlow(flowWithLlmStep({ model: 'gpt-4o-mini' }))).toThrow();
  });
});

function writeHelperPlugin(name: string, source: string): string {
  const entry = join(scratch, `${name}.mjs`);
  writeFileSync(entry, withRuntime(source));
  return entry;
}

function providerManifest(stream: boolean) {
  return {
    name: 'remote-provider',
    version: '1.0.0',
    capabilities: [],
    components: [{ componentType: 'AnthropicConfig', kind: 'provider', stream }],
  };
}

function remoteRegistry(entry: string, stream: boolean): PluginRegistry {
  const registry = PluginRegistry.empty();
  registry.addRemote(loadRemotePlugin(providerManifest(stream), entry, { timeout: 5000 }));
  open.push(registry);
  return registry;
}

describe('a provider in its own process', () => {
  it('answers a buffered chat', async () => {
    const entry = writeHelperPlugin(
      'buffered',
      `serve({ AnthropicConfig: { async chat(request, ctx) {
         return { content: 'answered ' + request.model + ' streaming=' + ctx.stream,
                  finish_reason: 'stop' };
       } } });`,
    );

    const state = await runFlow(remoteRegistry(entry, false), flowWithLlmStep(pluginModel()));

    expect(state.text).toBe('answered claude-sonnet-4-5 streaming=false');
    expect(builtinCalls).toHaveLength(0);
  });

  it('streams, and each partial becomes a token_delta', async () => {
    const entry = writeHelperPlugin(
      'streamed',
      `serve({ AnthropicConfig: { async chat(request, ctx) {
         for (const word of ['a ', 'poem ', 'about ', 'hi']) ctx.partial({ content: word });
         return { finish_reason: 'stop' };
       } } });`,
    );

    const events: Event[] = [];
    const state = await runFlow(
      remoteRegistry(entry, true),
      flowWithLlmStep(pluginModel()),
      { eventHandler: (e) => events.push(e) },
    );

    expect(state.text).toBe('a poem about hi');
    expect(events.filter((e) => e.type === 'token_delta').map((e) => e.delta)).toEqual([
      'a ',
      'poem ',
      'about ',
      'hi',
    ]);
  });

  it('never streams a provider whose manifest did not declare it', async () => {
    const entry = writeHelperPlugin(
      'nostream',
      `serve({ AnthropicConfig: { async chat(request, ctx) {
         if (ctx.stream) throw new Error('asked to stream without declaring it');
         return { content: 'buffered', finish_reason: 'stop' };
       } } });`,
    );

    const events: Event[] = [];
    const state = await runFlow(
      remoteRegistry(entry, false),
      flowWithLlmStep(pluginModel()),
      { eventHandler: (e) => events.push(e) },
    );

    expect(state.text).toBe('buffered');
    expect(events.filter((e) => e.type === 'token_delta')).toHaveLength(0);
  });

  it('refuses ctx.partial from a provider that was not asked for a stream', async () => {
    const entry = writeHelperPlugin(
      'badpartial',
      `serve({ AnthropicConfig: { async chat(request, ctx) {
         try { ctx.partial({ content: 'x' }); }
         catch (err) { return { content: 'refused: ' + err.message, finish_reason: 'stop' }; }
         return { content: 'allowed', finish_reason: 'stop' };
       } } });`,
    );

    const state = await runFlow(remoteRegistry(entry, false), flowWithLlmStep(pluginModel()));

    expect(String(state.text)).toMatch(
      /ctx\.partial is only available to a provider serving a streamed chat/,
    );
  });

  it('runs its tools through a runner of its own, not a sibling’s', async () => {
    const entry = writeHelperPlugin(
      'providertool',
      `serve({ AnthropicConfig: { async chat(request, ctx) {
         const out = await ctx.runTool('probe', { q: 'x' });
         return { content: 'tool said ' + out.answer, finish_reason: 'stop' };
       } } });`,
    );

    const registry = PluginRegistry.empty();
    registry.addRemote(
      loadRemotePlugin(
        {
          name: 'remote-provider',
          version: '1.0.0',
          capabilities: ['runTool'],
          components: [{ componentType: 'AnthropicConfig', kind: 'provider' }],
        },
        entry,
        { timeout: 5000, capabilities: ['runTool'] },
      ),
    );
    open.push(registry);

    const state = await runFlow(registry, flowWithLlmStep(pluginModel()), {
      toolRegistry: {
        lookup: (name) =>
          name === 'probe'
            ? { name, description: '', impl: { kind: 'path' as const, path: '/probe' } }
            : undefined,
        all: () => [],
      },
      toolExecutor: {
        execute: async () => ({ output: { answer: 'yes' }, stderr: '' }),
      },
    });

    expect(state.text).toBe('tool said yes');
  });

  it('does not send the operator credential across the pipe', async () => {
    const entry = writeHelperPlugin(
      'echo',
      `serve({ AnthropicConfig: { async chat(request, ctx) {
         return { content: JSON.stringify({ component: ctx.component, request }),
                  finish_reason: 'stop' };
       } } });`,
    );

    const state = await runFlow(remoteRegistry(entry, false), flowWithLlmStep(pluginModel()), {
      defaultLlmKey: 'operator-key',
      defaultLlmUrl: 'https://operator.example',
    });

    expect(String(state.text)).not.toContain('operator-key');
    expect(String(state.text)).not.toContain('operator.example');
  });

  it('refuses an answer with no content, naming the component', async () => {
    const entry = writeHelperPlugin(
      'nocontent',
      `serve({ AnthropicConfig: { async chat() { return { finish_reason: 'stop' }; } } });`,
    );

    await expect(
      runFlow(remoteRegistry(entry, false), flowWithLlmStep(pluginModel())),
    ).rejects.toThrow(/returned no "content" string/);
  });

  it('refuses a stream chunk whose content is not a string', async () => {
    const entry = writeHelperPlugin(
      'badchunk',
      `serve({ AnthropicConfig: { async chat(request, ctx) {
         ctx.partial({ content: 42 });
         return { finish_reason: 'stop' };
       } } });`,
    );

    await expect(
      runFlow(remoteRegistry(entry, true), flowWithLlmStep(pluginModel())),
    ).rejects.toThrow(/whose "content" is a number/);
  });

  it('fails the call when the final frame of a stream is malformed', async () => {
    const entry = writeHelperPlugin(
      'badfinal',
      `serve({ AnthropicConfig: { async chat(request, ctx) {
         ctx.partial({ content: 'most of an answer' });
         return { finish_reason: 7 };
       } } });`,
    );

    await expect(
      runFlow(remoteRegistry(entry, true), flowWithLlmStep(pluginModel())),
    ).rejects.toThrow(/"finish_reason" is a number/);
  });

  it('fails the step when a plugin dies mid-stream rather than keeping the prefix', async () => {
    const entry = writeHelperPlugin(
      'diesmidstream',
      `serve({ AnthropicConfig: { async chat(request, ctx) {
         ctx.partial({ content: 'half an ' });
         process.exit(3);
       } } });`,
    );

    await expect(
      runFlow(remoteRegistry(entry, true), flowWithLlmStep(pluginModel())),
    ).rejects.toThrow(/exited/);
  });

  it('reports a provider whose manifest declares it but which serves no chat', async () => {
    const entry = writeHelperPlugin(
      'nohandler',
      `serve({ AnthropicConfig: { execute: () => ({ output: {} }) } });`,
    );

    await expect(
      runFlow(remoteRegistry(entry, false), flowWithLlmStep(pluginModel())),
    ).rejects.toThrow(/serves no chat handler/);
  });
});

describe('a manifest declaring a provider', () => {
  it('accepts the kind and the stream flag', () => {
    const manifest = validateManifest(providerManifest(true));
    expect(manifest.components[0]).toMatchObject({
      componentType: 'AnthropicConfig',
      kind: 'provider',
      stream: true,
    });
  });

  it('defaults stream to false rather than undefined', () => {
    const manifest = validateManifest({
      name: 'p',
      version: '1.0.0',
      components: [{ componentType: 'AnthropicConfig', kind: 'provider' }],
    });
    expect(manifest.components[0].stream).toBe(false);
  });

  it('refuses a stream that is not a boolean', () => {
    expect(() =>
      validateManifest({
        name: 'p',
        version: '1.0.0',
        components: [{ componentType: 'AnthropicConfig', kind: 'provider', stream: 'yes' }],
      }),
    ).toThrow(/has a "stream" that is not a boolean/);
  });

  it('lists provider among the kinds it will accept', () => {
    expect(() =>
      validateManifest({
        name: 'p',
        version: '1.0.0',
        components: [{ componentType: 'X', kind: 'proviedr' }],
      }),
    ).toThrow(/expected node, transform, component, provider, middleware, encoder or store/);
  });

  it('refuses seams on a provider, as on every other non-middleware kind', () => {
    expect(() =>
      validateManifest({
        name: 'p',
        version: '1.0.0',
        components: [
          { componentType: 'AnthropicConfig', kind: 'provider', seams: { nodeError: ['after'] } },
        ],
      }),
    ).toThrow(/declares "seams" but its kind is "provider"/);
  });
});

describe('the chunk contract', () => {
  it('accumulates tool call fragments by index, as a builtin stream does', async () => {
    const entry = writeHelperPlugin(
      'toolstream',
      `serve({ AnthropicConfig: { async chat(request, ctx) {
         ctx.partial({ tool_calls: [{ index: 0, id: 'c1', name: 'echo', arguments: '{"a"' }] });
         ctx.partial({ tool_calls: [{ index: 0, arguments: ':1}' }] });
         return { finish_reason: 'tool_calls' };
       } } });`,
    );

    const registry = remoteRegistry(entry, true);
    const provider = providerFor(pluginModelSpec(), { plugins: registry });

    const chunks: ChatChunk[] = [];
    for await (const chunk of provider.chatCompletionStream!(undefined, {
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { tool_calls: [{ index: 0, id: 'c1', name: 'echo', arguments: '{"a"' }] },
      { tool_calls: [{ index: 0, arguments: ':1}' }] },
      { finish_reason: 'tool_calls' },
    ]);
  });
});
