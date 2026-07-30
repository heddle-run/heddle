/**
 * The `provider` kind — a plugin answering as an `llm_config`.
 *
 * Two properties run through everything here, and they pull in opposite
 * directions, which is why each is pinned from both sides.
 *
 * **A spec can name a provider heddle does not ship.** That is the feature, and
 * it costs the closed `LlmConfigUnion` — a plugin's config type now parses in
 * four positions that used to admit five builtins and nothing else.
 *
 * **A plugin cannot take a name the SDK ships.** That is what keeps the feature
 * from being a capture: a flow writing `OpenAiConfig` reaches heddle's own
 * client whatever plugins are loaded. `PluginRegistry.claim` refuses the
 * registration and `providerFor` checks builtins before it consults the
 * registry, and both halves are tested because either alone would be a rule
 * that holds until someone reorders something.
 */
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

/** Every request a plugin provider was asked to answer, in order. */
let asked: ChatRequest[] = [];
/** Every config a plugin provider was constructed from, in order. */
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

/**
 * What heddle would build for a builtin config, stubbed.
 *
 * Present in every `Dependencies` below so that a case which *should* reach a
 * plugin can prove it did not reach here — a missing credential would otherwise
 * fail these tests for the wrong reason and read as the plugin path working.
 */
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

/** An in-process plugin providing one custom `llm_config` type. */
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

/** A flow: start -> an LlmNode carrying `config` -> end. */
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

/** An `llm_config` naming a type only the plugin provides. */
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

// ---------------------------------------------------------------------------
// In process.
// ---------------------------------------------------------------------------

describe('a plugin provider answering a spec', () => {
  it('answers an LlmNode whose llm_config names it', async () => {
    const registry = providerPlugin('AnthropicConfig');

    const state = await runFlow(registry, flowWithLlmNode(pluginConfig()));

    expect(state.generated_text).toBe('from the plugin');
    // The model id is the spec's and reaches the plugin verbatim: a provider is
    // the endpoint, so unlike `callModel` it does get to see which model was
    // asked for — it is the thing that has to route it.
    expect(asked).toHaveLength(1);
    expect(asked[0].model).toBe('claude-sonnet-4-5');
    // And heddle's own client was never built. Without this assertion a plugin
    // path that silently fell through to the builtin would still pass above.
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
    // `$VAR` is *not* resolved on the way. heddle reads its own environment for
    // a config it is going to send itself; here the plugin sends it, and under
    // `--safe` that plugin is confined precisely so it cannot see this
    // process's environment — handing it a value from outside that confinement
    // is the mistake `ExecuteParams.workspace` refuses to make with a path.
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

    // Nothing about being a plugin makes a config's own settings the plugin's
    // problem: `generationParams` runs before the provider is even chosen.
    expect(asked[0]).toMatchObject({ temperature: 0.2, maxTokens: 64 });
  });

  it('builds the provider once for a node executed twice', async () => {
    // The precondition §7.6 names. `LLMExecutor` used to construct a provider
    // per execution, so a plugin holding a token bucket, a connection pool or a
    // response cache would have had it discarded between visits — the state it
    // exists to keep, silently dropped. Driven directly rather than through a
    // looping flow, because what is under test is the executor's lifetime.
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
    // A judge node whose `llm_config` names another plugin's provider. Nothing
    // in `PluginModel` knows the difference, which is the point of routing
    // every provider construction through one function.
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

// ---------------------------------------------------------------------------
// What a provider may not be. Every case here is a way the feature could turn
// into a capture, or into a message nobody can act on.
// ---------------------------------------------------------------------------

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
    // The other half of the same guarantee, and the one that would survive a
    // registry check being loosened: `providerFor` tests `isBuiltinConfigType`
    // *before* it looks anything up, so there is no lookup to win.
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
    // The double lock is only a lock while these two sets agree in this
    // direction. `claim` refuses a registration using the SDK's
    // `isBuiltinComponentType`; `providerFor` skips the registry using
    // `isBuiltinConfigType`, which reads heddle's own OPENAI_COMPATIBLE_TYPES.
    // A name in heddle's set but not the SDK's would be registrable by a plugin
    // *and* never looked up — a config type a plugin could claim and then never
    // be asked about, which is a confusing dead end rather than a capture, but
    // the reverse of the property the two checks are supposed to share.
    for (const type of ['OpenAiConfig', 'OpenAiCompatibleConfig', 'VllmConfig', 'OllamaConfig']) {
      expect(isBuiltinConfigType(type)).toBe(true);
      expect(isBuiltinComponentType(type)).toBe(true);
    }
    // The other direction does not hold and does not need to: `OciGenAiConfig`
    // is an SDK builtin heddle cannot build a client for. A plugin still cannot
    // claim it — `claim` reads the SDK — so it reaches `providerFor`'s
    // no-plugin-provides branch and is refused there by name.
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

    // And it is refused as what it is — an Agent Spec type heddle has no client
    // for — rather than as an unknown one. The difference is the advice: the
    // "unsupported config type" branch ends with "load it with --plugin", which
    // for a builtin sends an operator looking for a plugin `claim` would refuse.
    expect(() =>
      providerFor(
        { componentType: 'OciGenAiConfig', modelId: 'x' },
        { plugins: registry, createProvider: builtinProvider },
      ),
    ).toThrow(/Agent Spec defines but heddle has no client for/);

    // Same answer with no registry in play. The refusal is a property of the
    // type, not of what happens to be loaded beside it.
    expect(() =>
      providerFor(
        { componentType: 'OciGenAiConfig', modelId: 'x' },
        { createProvider: builtinProvider },
      ),
    ).toThrow(/No plugin can supply it either/);
  });

  it('never offers an SDK builtin to the registry at all', () => {
    // The strengthened form of the double lock. Before this, the registry was
    // skipped only for the four types heddle can build, so `OciGenAiConfig`
    // reached the lookup and the invariant rested on `claim` alone. Now every
    // SDK builtin stops first, whether or not heddle has a client for it.
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
        // OciGenAiConfig throws; OpenAiConfig does not. Neither may look up.
      }
    }
    expect(asked).toEqual([]);
  });

  it('refuses a plugin transform written as an llm_config, naming its kind', () => {
    // The slot discipline the widened union gave up. Before widening this was
    // `Invalid discriminator value`; now it is a sentence saying what the type
    // actually is.
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
    // `Dependencies.createProvider` answers "how does heddle build its own
    // client", not "who answers for AnthropicConfig". One field doing both
    // would mean an embedder installing a stub had silently switched off every
    // provider the operator loaded.
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

// ---------------------------------------------------------------------------
// The union this rests on.
// ---------------------------------------------------------------------------

describe('the widened LlmConfigUnion', () => {
  it('parses a flow whose llm_config is a plugin type', () => {
    const registry = providerPlugin('AnthropicConfig');
    open.push(registry);

    const flow = parseFlow(flowWithLlmNode(pluginConfig()), registry);
    const node = flow.parsedNodes.find((n) => n.name === 'p') as {
      llmConfig?: { componentType?: string; modelId?: string };
    };

    // The real component in place, not a stand-in swapped back afterwards:
    // before the widening this position took a fabricated `OllamaConfig`
    // pointing at localhost:11434.
    expect(node.llmConfig?.componentType).toBe('AnthropicConfig');
    expect(node.llmConfig?.modelId).toBe('claude-sonnet-4-5');
  });

  it('still refuses a builtin config missing a required field', () => {
    // The safety argument. A builtin componentType never reaches the widened
    // branch, so `OpenAiConfig` with no `model_id` fails exactly as it did.
    expect(() =>
      parseFlow(flowWithLlmNode({ component_type: 'OpenAiConfig', name: 'llm' })),
    ).toThrow();
  });

  it('still refuses an object that is no config at all', () => {
    // No usable `componentType`, so the widened branch declines it and the
    // original union's own issues are what a consumer sees.
    expect(() => parseFlow(flowWithLlmNode({ model_id: 'gpt-4o-mini' }))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Out of process, where a model answer is a frame on a pipe.
// ---------------------------------------------------------------------------

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

    // The accumulation of the stream is the answer the buffered call would have
    // returned — that is `completeChat`'s whole contract, and a remote provider
    // has to satisfy it through a pipe.
    expect(state.generated_text).toBe('a poem about hi');
    expect(events.filter((e) => e.type === 'token_delta').map((e) => e.delta)).toEqual([
      'a ',
      'poem ',
      'about ',
      'hi',
    ]);
  });

  it('never streams a provider whose manifest did not declare it', async () => {
    // `completeChat` decides by whether `chatCompletionStream` exists, and
    // `remoteProviderDef` only defines it when the manifest said so. A provider
    // that never implemented streaming must not be asked to.
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
    // A provider owns no tool scope, so it gets the scopeless runner a
    // transform gets — but passed explicitly. Left to `PluginHost`'s host-wide
    // fallback it would have used whatever `setToolRunner` was first given, so
    // a plugin shipping both a node and a provider would run the provider's
    // tools inside the node's sandbox session, and the same provider loaded
    // alone would get a throwaway one. The assertion that matters is not which
    // session it lands in — it is that the tool resolves at all, from a
    // component that installed no runner and has no sibling to borrow one from.
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
    // The rule `providerFor` states and the boundary that enforces it: `deps`
    // holds the operator's key and `remoteProviderDef` sends the component and
    // the request, so there is nothing on the wire for a plugin to find.
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
    // Chunks are concatenated, so a number here becomes `'' + 42` in the
    // answer — a corruption that would surface as the node's output being
    // wrong, several frames from the provider that caused it.
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
    // The response is the last chunk, so it is read by the same reader as the
    // partials — but it arrives on a `.then` callback with nothing above it to
    // catch. Left to throw there it would be an unhandled rejection, the
    // iterator would finish normally, and the node would get whatever had been
    // streamed so far as a complete answer.
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
    // Rule 2: the response is what ends a stream. A process that emits chunks
    // and then exits has produced no answer, however much text it sent — the
    // same rule `completeChat` applies to a provider that throws.
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

// ---------------------------------------------------------------------------
// The manifest half.
// ---------------------------------------------------------------------------

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

// A guard against the chunk reader drifting from what `collectStream` expects.
// Kept beside the wire tests because it is the same contract read from the
// other end: whatever a plugin sends as partials has to accumulate into the
// response the buffered call would have given.
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
