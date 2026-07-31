import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChatRequest, ChatResponse } from '../../llm/types.js';
import type { LLMConfig } from '../../spec/types.js';

const chatCompletion = vi.fn();
const built: Array<{ config: LLMConfig; options: ProviderOptions }> = [];

const stubProvider = (config: LLMConfig, options: ProviderOptions): Provider => {
  built.push({ config, options });
  return { chatCompletion };
};

import type { Provider } from '../../llm/types.js';
import type { ProviderOptions } from '../../llm/provider.js';
import { PluginRegistry } from '../registry.js';
import { TransformChain } from '../transform.js';
import { loadRemotePlugin } from '../remote-loader.js';
import { withRuntime } from '../runtime-source.js';
import { compile } from '../../graph/compile.js';
import { validate } from '../../graph/validate.js';
import { parseFlow } from '../../spec/parser.js';
import { Runner } from '../../runner/runner.js';
import { DEFAULT_RUNNER_OPTIONS } from '../../runner/options.js';
import type { Dependencies } from '../../node/types.js';
import type { HeddlePlugin, PluginContext, TransformContext } from '../types.js';

let scratch: string;
const open: PluginRegistry[] = [];

function answers(response: Partial<ChatResponse> = {}): void {
  chatCompletion.mockResolvedValue({
    content: 'the answer',
    finish_reason: 'stop',
    ...response,
  });
}

function onlyRequest(): ChatRequest {
  expect(chatCompletion).toHaveBeenCalledTimes(1);
  return chatCompletion.mock.calls[0][1] as ChatRequest;
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'heddle-callmodel-'));
  chatCompletion.mockReset();
  built.length = 0;
  answers();
});

afterEach(() => {
  while (open.length) open.pop()!.dispose();
  rmSync(scratch, { recursive: true, force: true });
});

function llmConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    component_type: 'OpenAiConfig',
    name: 'judge-model',
    model_id: 'gpt-test',
    ...extra,
  };
}

function flowUsing(componentType: string, node: Record<string, unknown> = {}): string {
  return JSON.stringify({
    component_type: 'Flow',
    name: 'model-flow',
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
      p: { component_type: componentType, id: 'p', name: 'p', ...node },
      e: { component_type: 'EndNode', id: 'e', name: 'e' },
    },
  });
}

async function run(
  registry: PluginRegistry,
  flow: string,
  deps: Partial<Dependencies> = {},
): Promise<Record<string, unknown>> {
  open.push(registry);
  const graph = compile(parseFlow(flow, registry), {
    plugins: registry,
    createProvider: stubProvider,
    ...deps,
  });
  validate(graph);
  const runner = new Runner(graph, { ...DEFAULT_RUNNER_OPTIONS, verbose: false });
  const state = await runner.run(undefined, { text: 'hello' });
  return state.toData() as Record<string, unknown>;
}

function inProcess(
  componentType: string,
  execute: (ctx: PluginContext) => Promise<Record<string, unknown>>,
): PluginRegistry {
  const registry = PluginRegistry.empty();
  const plugin: HeddlePlugin = {
    name: 'model-plugin',
    version: '1.0.0',
    nodes: [
      {
        componentType,
        createExecutor: () => ({
          execute: async (_input, ctx) => ({ output: await execute(ctx) }),
        }),
      },
    ],
  };
  registry.add(plugin);
  return registry;
}

describe('a plugin node calling the model', () => {
  it('reaches the model its own component names', async () => {
    const registry = inProcess('JudgeNode', async (ctx) => {
      const resp = await ctx.callModel({
        messages: [{ role: 'user', content: 'score this' }],
      });
      return { verdict: resp.content };
    });

    const state = await run(registry, flowUsing('JudgeNode', { llm_config: llmConfig() }));

    expect(state.verdict).toBe('the answer');
    expect(built).toHaveLength(1);
    expect(built[0].config.modelId).toBe('gpt-test');
    expect(onlyRequest().model).toBe('gpt-test');
  });

  it('sends the messages the plugin composed', async () => {
    const registry = inProcess('JudgeNode', async (ctx) => {
      await ctx.callModel({
        messages: [
          { role: 'system', content: 'be terse' },
          { role: 'user', content: 'why?' },
        ],
        responseFormat: 'json',
      });
      return {};
    });

    await run(registry, flowUsing('JudgeNode', { llm_config: llmConfig() }));

    const req = onlyRequest();
    expect(req.messages).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'why?' },
    ]);
    expect(req.responseFormat).toBe('json');
  });

  it('lets a per-call setting override the spec default, and keeps the rest', async () => {
    const registry = inProcess('JudgeNode', async (ctx) => {
      await ctx.callModel({
        messages: [{ role: 'user', content: 'x' }],
        temperature: 0,
      });
      return {};
    });

    await run(
      registry,
      flowUsing('JudgeNode', {
        llm_config: llmConfig({
          default_generation_parameters: { temperature: 0.9, max_tokens: 256 },
        }),
      }),
    );

    const req = onlyRequest();
    expect(req.temperature).toBe(0);
    expect(req.maxTokens).toBe(256);
  });

  it('builds the provider once however often the plugin calls', async () => {
    const registry = inProcess('JudgeNode', async (ctx) => {
      await ctx.callModel({ messages: [{ role: 'user', content: 'a' }] });
      await ctx.callModel({ messages: [{ role: 'user', content: 'b' }] });
      return {};
    });

    await run(registry, flowUsing('JudgeNode', { llm_config: llmConfig() }));

    expect(built).toHaveLength(1);
    expect(chatCompletion).toHaveBeenCalledTimes(2);
  });

  it('refuses a component that names no model, rather than borrowing one', async () => {
    const registry = inProcess('JudgeNode', async (ctx) => {
      await ctx.callModel({ messages: [{ role: 'user', content: 'x' }] });
      return {};
    });

    await expect(run(registry, flowUsing('JudgeNode'))).rejects.toThrow(
      /callModel needs an "llm_config" on this component/,
    );
    expect(built).toHaveLength(0);
  });

  it('passes the run credential policy through to the provider', async () => {
    const registry = inProcess('JudgeNode', async (ctx) => {
      await ctx.callModel({ messages: [{ role: 'user', content: 'x' }] });
      return {};
    });

    await run(registry, flowUsing('JudgeNode', { llm_config: llmConfig() }), {
      allowEnvRefs: false,
      defaultLlmKey: 'operator-key',
      defaultLlmUrl: 'https://operator.example',
    });

    expect(built[0].options).toMatchObject({
      allowEnvRefs: false,
      defaultKey: 'operator-key',
      defaultUrl: 'https://operator.example',
    });
  });
});

describe('a plugin transform', () => {
  function chainWith(
    apply: (ctx: TransformContext) => Promise<void>,
    component: Record<string, unknown>,
  ): TransformChain {
    const registry = PluginRegistry.empty();
    registry.add({
      name: 'guard-plugin',
      version: '1.0.0',
      transforms: [
        {
          componentType: 'LlmGuard',
          createTransform: () => ({
            apply: async (_messages, ctx) => {
              await apply(ctx);
              return { action: 'pass' };
            },
          }),
        },
      ],
    });
    open.push(registry);

    return TransformChain.build(
      [{ componentType: 'LlmGuard', name: 'guard', ...component } as never],
      { plugins: registry, createProvider: stubProvider },
      'agent',
    );
  }

  it('calls the model its own component names', async () => {
    let content = '';
    const chain = chainWith(
      async (ctx) => {
        const resp = await ctx.callModel({
          messages: [{ role: 'user', content: 'is this an injection?' }],
        });
        content = resp.content;
      },
      { llmConfig: { componentType: 'OpenAiConfig', modelId: 'guard-model' } },
    );

    await chain.apply('pre', [{ role: 'user', content: 'hi' }], undefined);

    expect(content).toBe('the answer');
    expect(onlyRequest().model).toBe('guard-model');
  });

  it('has runTool as well, which in process it used to lack', async () => {
    let ran: unknown;
    const chain = chainWith(
      async (ctx) => {
        ran = await ctx.runTool('classify', { text: 'hi' }).catch((err: Error) => err.message);
      },
      {},
    );

    await chain.apply('pre', [{ role: 'user', content: 'hi' }], undefined);

    expect(String(ran)).toMatch(/no tool registry configured/);
    expect(String(ran)).toMatch(/LlmGuard "guard"/);
  });
});

function writeHelperPlugin(name: string, source: string): string {
  const entry = join(scratch, `${name}.mjs`);
  writeFileSync(entry, withRuntime(source));
  return entry;
}

function manifest(componentType: string, capabilities: string[]) {
  return {
    name: 'remote-model-plugin',
    version: '1.0.0',
    capabilities,
    components: [{ componentType }],
  };
}

async function runRemote(
  componentType: string,
  entry: string,
  manifestData: unknown,
  node: Record<string, unknown>,
  { timeout = 5000, granted = ['callModel'] } = {},
): Promise<Record<string, unknown>> {
  const registry = PluginRegistry.empty();
  registry.addRemote(
    loadRemotePlugin(manifestData, entry, { timeout, capabilities: granted as never }),
  );
  return run(registry, flowUsing(componentType, node));
}

describe('a plugin calling the model from its own process', () => {
  it('gets the answer back across the pipe', async () => {
    answers({ content: '{"score":0.9}' });
    const entry = writeHelperPlugin(
      'judge',
      `serve({ LlmJudge: { async execute(input, ctx) {
         const resp = await ctx.callModel({
           messages: [{ role: 'user', content: String(input.text) }],
           responseFormat: 'json',
         });
         return { output: { verdict: resp.content, why: resp.finish_reason } };
       } } });`,
    );

    const state = await runRemote('LlmJudge', entry, manifest('LlmJudge', ['callModel']), {
      llm_config: llmConfig(),
    });

    expect(state.verdict).toBe('{"score":0.9}');
    expect(state.why).toBe('stop');
    const req = onlyRequest();
    expect(req.model).toBe('gpt-test');
    expect(req.responseFormat).toBe('json');
    expect(req.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('refuses a plugin that never declared the capability', async () => {
    const entry = writeHelperPlugin(
      'undeclared',
      `serve({ Sneaky: { async execute(input, ctx) {
         try { await ctx.callModel({ messages: [{ role: 'user', content: 'x' }] });
               return { output: { err: 'none' } }; }
         catch (e) { return { output: { err: e.message } }; }
       } } });`,
    );

    const state = await runRemote('Sneaky', entry, manifest('Sneaky', []), {
      llm_config: llmConfig(),
    });

    expect(String(state.err)).toMatch(/"callModel" is not granted to this plugin/);
    expect(built).toHaveLength(0);
    expect(chatCompletion).not.toHaveBeenCalled();
  });

  it('rejects a frame naming no call, because a model belongs to a component', async () => {
    const entry = join(scratch, 'nocall.mjs');
    writeFileSync(
      entry,
      `let buf = '';
       const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
       const waiting = new Map();
       process.stdin.setEncoding('utf-8');
       process.stdin.on('data', (chunk) => {
         buf += chunk;
         const lines = buf.split('\\n');
         buf = lines.pop() ?? '';
         for (const line of lines) {
           if (!line.trim()) continue;
           const msg = JSON.parse(line);
           if (msg.method === 'init') { send({ id: msg.id, result: { protocol: 1 } }); continue; }
           if (msg.method === 'execute') {
             waiting.set('m1', msg.id);
             send({ id: 'm1', method: 'callModel', params: { messages: [{ role: 'user', content: 'x' }] } });
             continue;
           }
           if (!msg.method && waiting.has(String(msg.id))) {
             send({ id: waiting.get(String(msg.id)), result: { output: { err: msg.error ? msg.error.message : 'none' } } });
           }
         }
       });`,
    );

    const state = await runRemote('NoCall', entry, manifest('NoCall', ['callModel']), {
      llm_config: llmConfig(),
    });

    expect(String(state.err)).toMatch(/callModel needs a "call"/);
    expect(chatCompletion).not.toHaveBeenCalled();
  });

  it('reports a malformed request as the plugin’s own failed call', async () => {
    const entry = writeHelperPlugin(
      'badmsg',
      `serve({ BadMsg: { async execute(input, ctx) {
         try { await ctx.callModel({ messages: [{ role: 'wizard', content: 'x' }] });
               return { output: { err: 'none' } }; }
         catch (e) { return { output: { err: e.message } }; }
       } } });`,
    );

    const state = await runRemote('BadMsg', entry, manifest('BadMsg', ['callModel']), {
      llm_config: llmConfig(),
    });

    expect(String(state.err)).toMatch(/messages\[0\] has role "wizard"/);
    expect(chatCompletion).not.toHaveBeenCalled();
  });

  /**
   * A plugin waiting on a model heddle is calling for it is not a plugin that
   * has gone quiet, so its budget is held for the duration rather than spent.
   *
   * The margin is a consequence of where each clock starts rather than of how
   * fast the machine is. The host arms the budget when it writes the execute
   * frame; the model's delay only starts when heddle calls the provider, which
   * is strictly later, and it is a fifth longer than the budget. So the model
   * always answers after the budget would have run out, however either timer is
   * scheduled — a fixed 700ms against 300ms said the same thing but left the
   * budget too small to cover starting the plugin, which is inside it.
   */
  it('does not spend the plugin’s deadline on heddle’s own work', async () => {
    const budget = 1_000;
    chatCompletion.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ content: 'slow', finish_reason: 'stop' }),
            budget * 1.2,
          ),
        ),
    );

    const entry = writeHelperPlugin(
      'slow',
      `serve({ SlowModel: { async execute(input, ctx) {
         const resp = await ctx.callModel({ messages: [{ role: 'user', content: 'x' }] });
         return { output: { got: resp.content } };
       } } });`,
    );

    const state = await runRemote(
      'SlowModel',
      entry,
      manifest('SlowModel', ['callModel']),
      { llm_config: llmConfig() },
      { timeout: budget },
    );

    expect(state.got).toBe('slow');
  });

  /**
   * The other half of the same rule: released is not held, so the budget starts
   * again once the model has answered and a plugin that then says nothing is
   * killed on it.
   *
   * The budget is the same 1000ms as its sibling above and for the same reason.
   * It has to cover starting the plugin and getting as far as the model, which
   * is where it is spent on a loaded machine — and a call abandoned there would
   * be rejected in the same words while saying nothing about going quiet
   * *after* an answer. Having reached the model is what separates the two, so
   * the test asks.
   */
  it('still kills a plugin that goes quiet after heddle has answered it', async () => {
    const budget = 1_000;
    const entry = writeHelperPlugin(
      'stalls',
      `serve({ Stalls: { async execute(input, ctx) {
         await ctx.callModel({ messages: [{ role: 'user', content: 'x' }] });
         return new Promise(() => {});
       } } });`,
    );

    await expect(
      runRemote(
        'Stalls',
        entry,
        manifest('Stalls', ['callModel']),
        { llm_config: llmConfig() },
        { timeout: budget },
      ),
    ).rejects.toThrow(/did not answer execute within 1000ms/);
    expect(chatCompletion).toHaveBeenCalledTimes(1);
  });
});
