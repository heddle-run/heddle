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
import { isBuiltinComponentType } from 'agentspec';
import { isBuiltinConfigType, providerFor } from '../../llm/provider.js';
import type { Dependencies } from '../../node/types.js';
import type { ChatChunk, ChatRequest, ChatResponse, Provider } from '../../llm/types.js';
import type { LLMConfig, LLMNode } from '../../spec/types.js';
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

const builtinCalls: LLMConfig[] = [];
const builtinProvider = (config: LLMConfig): Provider => {
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

function flowWithLlmNode(config: Record<string, unknown>): string {
  return JSON.stringify({
    component_type: 'Flow',
    name: 'provider-flow',
    start_node: { $component_ref: 's' },
    nodes: [{ $component_ref: 's' }, { $component_ref: 'p' }, { $component_ref: 'e' }],
    control_flow_connections: [
      {
        component_type: 'ControlFlowEdge',
        name: 'a',
        from_node: { $component_ref: 's' },
        to_node: { $component_ref: 'p' },
      },
      {
        component_type: 'ControlFlowEdge',
        name: 'b',
        from_node: { $component_ref: 'p' },
        to_node: { $component_ref: 'e' },
      },
    ],
    $referenced_components: {
      s: {
        component_type: 'StartNode',
        id: 's',
        name: 's',
        outputs: [{ title: 'text', type: 'string' }],
      },
      p: {
        component_type: 'LlmNode',
        id: 'p',
        name: 'p',
        prompt_template: 'say something',
        llm_config: config,
      },
      e: { component_type: 'EndNode', id: 'e', name: 'e' },
    },
  });
}

function pluginConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    component_type: 'AnthropicConfig',
    name: 'claude',
    model_id: 'claude-sonnet-4-5',
    ...extra,
  };
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

describe('a plugin provider answering a spec', () => {
  it('answers an LlmNode whose llm_config names it', async () => {
    const registry = providerPlugin('AnthropicConfig');

    const state = await runFlow(registry, flowWithLlmNode(pluginConfig()));

    expect(state.generated_text).toBe('from the plugin');
    expect(asked).toHaveLength(1);
    expect(asked[0].model).toBe('claude-sonnet-4-5');
    expect(builtinCalls).toHaveLength(0);
  });

  it('hands over the config the spec wrote, camelCased and otherwise untouched', async () => {
    const registry = providerPlugin('AnthropicConfig');

    await runFlow(
      registry,
      flowWithLlmNode(pluginConfig({ api_key: '$ANTHROPIC_KEY', anthropic_version: '2023-06-01' })),
    );

    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      componentType: 'AnthropicConfig',
      modelId: 'claude-sonnet-4-5',
      anthropicVersion: '2023-06-01',
    });
    expect(configs[0].apiKey).toBe('$ANTHROPIC_KEY');
  });

  it('reads the spec generation parameters into the request, as a builtin does', async () => {
    const registry = providerPlugin('AnthropicConfig');

    await runFlow(
      registry,
      flowWithLlmNode(
        pluginConfig({ default_generation_parameters: { temperature: 0.2, max_tokens: 64 } }),
      ),
    );

    expect(asked[0]).toMatchObject({ temperature: 0.2, maxTokens: 64 });
  });

  it('builds the provider once for a node executed twice', async () => {
    const registry = providerPlugin('AnthropicConfig');
    open.push(registry);

    const node = {
      componentType: 'LlmNode',
      name: 'p',
      promptTemplate: 'say something',
      llmConfig: {
        componentType: 'AnthropicConfig',
        name: 'claude',
        modelId: 'claude-sonnet-4-5',
      },
    } as unknown as LLMNode;

    const executor = new LLMExecutor(node, {
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
      component_type: 'Flow',
      name: 'judge-flow',
      start_node: { $component_ref: 's' },
      nodes: [{ $component_ref: 's' }, { $component_ref: 'p' }, { $component_ref: 'e' }],
      control_flow_connections: [
        {
          component_type: 'ControlFlowEdge',
          name: 'a',
          from_node: { $component_ref: 's' },
          to_node: { $component_ref: 'p' },
        },
        {
          component_type: 'ControlFlowEdge',
          name: 'b',
          from_node: { $component_ref: 'p' },
          to_node: { $component_ref: 'e' },
        },
      ],
      $referenced_components: {
        s: {
          component_type: 'StartNode',
          id: 's',
          name: 's',
          outputs: [{ title: 'text', type: 'string' }],
        },
        p: {
          component_type: 'JudgeNode',
          id: 'p',
          name: 'p',
          llm_config: pluginConfig(),
        },
        e: { component_type: 'EndNode', id: 'e', name: 'e' },
      },
    });

    const state = await runFlow(registry, flow);

    expect(state.verdict).toBe('from the plugin');
    expect(builtinCalls).toHaveLength(0);
  });
});

describe('what a provider may not take', () => {
  it('refuses a plugin claiming a builtin config type, at load', () => {
    expect(() =>
      PluginRegistry.fromPlugins([
        {
          name: 'sneaky',
          version: '1.0.0',
          providers: [{ componentType: 'OpenAiConfig', createProvider: () => builtinProvider({ modelId: 'x' }) }],
        },
      ]),
    ).toThrow(/"OpenAiConfig", which is a builtin Agent Spec type/);
  });

  it('sends a builtin config to the builtin path even with providers loaded', () => {
    const registry = providerPlugin('AnthropicConfig');
    open.push(registry);

    const provider = providerFor(
      { componentType: 'OpenAiConfig', modelId: 'gpt-4o-mini' },
      { plugins: registry, createProvider: builtinProvider },
    );

    expect(builtinCalls).toHaveLength(1);
    expect(configs).toHaveLength(0);
    expect(provider).toBeDefined();
  });

  it('agrees with the SDK about what a builtin config type is', () => {
    for (const type of ['OpenAiConfig', 'OpenAiCompatibleConfig', 'VllmConfig', 'OllamaConfig']) {
      expect(isBuiltinConfigType(type)).toBe(true);
      expect(isBuiltinComponentType(type)).toBe(true);
    }
    expect(isBuiltinComponentType('OciGenAiConfig')).toBe(true);
    expect(isBuiltinConfigType('OciGenAiConfig')).toBe(false);
  });

  it('refuses an SDK config type heddle cannot build, without offering it to a plugin', () => {
    const registry = providerPlugin('AnthropicConfig');
    open.push(registry);

    expect(() =>
      PluginRegistry.fromPlugins([
        {
          name: 'oci',
          version: '1.0.0',
          providers: [
            { componentType: 'OciGenAiConfig', createProvider: () => builtinProvider({ modelId: 'x' }) },
          ],
        },
      ]),
    ).toThrow(/builtin Agent Spec type/);

    expect(() =>
      providerFor(
        { componentType: 'OciGenAiConfig', modelId: 'x' },
        { plugins: registry, createProvider: builtinProvider },
      ),
    ).toThrow(/Agent Spec defines but heddle has no client for/);

    expect(() =>
      providerFor(
        { componentType: 'OciGenAiConfig', modelId: 'x' },
        { createProvider: builtinProvider },
      ),
    ).toThrow(/No plugin can supply it either/);
  });

  it('never offers an SDK builtin to the registry at all', () => {
    const registry = providerPlugin('AnthropicConfig');
    open.push(registry);
    const asked: string[] = [];
    const spy = new Proxy(registry, {
      get(target, prop, receiver) {
        if (prop === 'providerDef' || prop === 'kindOf') {
          return (type: string) => {
            asked.push(type);
            return (Reflect.get(target, prop, receiver) as (t: string) => unknown).call(target, type);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    for (const builtin of ['OpenAiConfig', 'OciGenAiConfig']) {
      try {
        providerFor(
          { componentType: builtin, modelId: 'x' },
          { plugins: spy, createProvider: builtinProvider },
        );
      } catch {
      }
    }
    expect(asked).toEqual([]);
  });

  it('refuses a plugin transform written as an llm_config, naming its kind', () => {
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
        { componentType: 'Guard', modelId: 'x' },
        { plugins: registry, createProvider: builtinProvider },
      ),
    ).toThrow(/provides as a transform rather than a provider/);
  });

  it('names the loaded plugins for a config type nothing provides', () => {
    const registry = providerPlugin('AnthropicConfig');
    open.push(registry);

    expect(() =>
      providerFor(
        { componentType: 'BedrockConfig', modelId: 'x' },
        { plugins: registry, createProvider: builtinProvider },
      ),
    ).toThrow(/unsupported config type "BedrockConfig"[\s\S]*anthropic-plugin@1\.0\.0/);
  });

  it('does not let an embedder’s factory shadow a provider plugin', () => {
    const registry = providerPlugin('AnthropicConfig');
    open.push(registry);

    providerFor(
      { componentType: 'AnthropicConfig', modelId: 'claude-sonnet-4-5' },
      { plugins: registry, createProvider: builtinProvider },
    );

    expect(configs).toHaveLength(1);
    expect(builtinCalls).toHaveLength(0);
  });
});

describe('the widened LlmConfigUnion', () => {
  it('parses a flow whose llm_config is a plugin type', () => {
    const registry = providerPlugin('AnthropicConfig');
    open.push(registry);

    const flow = parseFlow(flowWithLlmNode(pluginConfig()), registry);
    const node = flow.parsedNodes.find((n) => n.name === 'p') as {
      llmConfig?: { componentType?: string; modelId?: string };
    };

    expect(node.llmConfig?.componentType).toBe('AnthropicConfig');
    expect(node.llmConfig?.modelId).toBe('claude-sonnet-4-5');
  });

  it('still refuses a builtin config missing a required field', () => {
    expect(() =>
      parseFlow(flowWithLlmNode({ component_type: 'OpenAiConfig', name: 'llm' })),
    ).toThrow();
  });

  it('still refuses an object that is no config at all', () => {
    expect(() => parseFlow(flowWithLlmNode({ model_id: 'gpt-4o-mini' }))).toThrow();
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

    const state = await runFlow(remoteRegistry(entry, false), flowWithLlmNode(pluginConfig()));

    expect(state.generated_text).toBe('answered claude-sonnet-4-5 streaming=false');
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
      flowWithLlmNode(pluginConfig()),
      { eventHandler: (e) => events.push(e) },
    );

    expect(state.generated_text).toBe('a poem about hi');
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
      flowWithLlmNode(pluginConfig()),
      { eventHandler: (e) => events.push(e) },
    );

    expect(state.generated_text).toBe('buffered');
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

    const state = await runFlow(remoteRegistry(entry, false), flowWithLlmNode(pluginConfig()));

    expect(String(state.generated_text)).toMatch(
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

    const state = await runFlow(registry, flowWithLlmNode(pluginConfig()), {
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

    expect(state.generated_text).toBe('tool said yes');
  });

  it('does not send the operator credential across the pipe', async () => {
    const entry = writeHelperPlugin(
      'echo',
      `serve({ AnthropicConfig: { async chat(request, ctx) {
         return { content: JSON.stringify({ component: ctx.component, request }),
                  finish_reason: 'stop' };
       } } });`,
    );

    const state = await runFlow(remoteRegistry(entry, false), flowWithLlmNode(pluginConfig()), {
      defaultLlmKey: 'operator-key',
      defaultLlmUrl: 'https://operator.example',
    });

    expect(String(state.generated_text)).not.toContain('operator-key');
    expect(String(state.generated_text)).not.toContain('operator.example');
  });

  it('refuses an answer with no content, naming the component', async () => {
    const entry = writeHelperPlugin(
      'nocontent',
      `serve({ AnthropicConfig: { async chat() { return { finish_reason: 'stop' }; } } });`,
    );

    await expect(
      runFlow(remoteRegistry(entry, false), flowWithLlmNode(pluginConfig())),
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
      runFlow(remoteRegistry(entry, true), flowWithLlmNode(pluginConfig())),
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
      runFlow(remoteRegistry(entry, true), flowWithLlmNode(pluginConfig())),
    ).rejects.toThrow(/"finish_reason" is a number/);
  });

  it('fails the node when a plugin dies mid-stream rather than keeping the prefix', async () => {
    const entry = writeHelperPlugin(
      'diesmidstream',
      `serve({ AnthropicConfig: { async chat(request, ctx) {
         ctx.partial({ content: 'half an ' });
         process.exit(3);
       } } });`,
    );

    await expect(
      runFlow(remoteRegistry(entry, true), flowWithLlmNode(pluginConfig())),
    ).rejects.toThrow(/exited/);
  });

  it('reports a provider whose manifest declares it but which serves no chat', async () => {
    const entry = writeHelperPlugin(
      'nohandler',
      `serve({ AnthropicConfig: { execute: () => ({ output: {} }) } });`,
    );

    await expect(
      runFlow(remoteRegistry(entry, false), flowWithLlmNode(pluginConfig())),
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
    ).toThrow(/expected node, transform, component, provider, middleware or encoder/);
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
    const provider = providerFor(
      { componentType: 'AnthropicConfig', name: 'claude', modelId: 'claude-sonnet-4-5' },
      { plugins: registry },
    );

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
