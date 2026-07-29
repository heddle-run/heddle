/**
 * `callModel` — a plugin asking heddle to talk to a model for it.
 *
 * The property under test throughout is *whose decision is whose*. A plugin
 * composes the request; the spec names the model, the endpoint and the
 * credential. Every case below is one way that could come apart: a plugin
 * reaching a model its own component did not name, a component with no config
 * quietly borrowing someone else's, a transform being able to do less than a
 * node for no reason an author could see, or a per-call setting silently
 * erasing the spec's default.
 *
 * The provider is stubbed through `Dependencies.createProvider`, which is the
 * seam between "which config" and "which network call", so replacing it leaves
 * everything this file is about — reading the config, merging the parameters,
 * routing the reverse call — running for real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChatRequest, ChatResponse } from '../../llm/types.js';
import type { LLMConfig } from '../../spec/types.js';

const chatCompletion = vi.fn();
const built: Array<{ config: LLMConfig; options: Record<string, unknown> }> = [];

// Records the config it was asked for, which is the whole question: a plugin
// must not be able to reach a model its own component did not name.
const stubProvider = (config: LLMConfig, options: Record<string, unknown>) => {
  built.push({ config, options });
  return { chatCompletion };
};

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

/** The answer the stub gives unless a case wants a different one. */
function answers(response: Partial<ChatResponse> = {}): void {
  chatCompletion.mockResolvedValue({
    content: 'the answer',
    finish_reason: 'stop',
    ...response,
  });
}

/** The single request the stub was given. Fails loudly on none, or more than one. */
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

/** An `llm_config` as a spec writes one, for a plugin component to carry. */
function llmConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    component_type: 'OpenAiConfig',
    name: 'judge-model',
    model_id: 'gpt-test',
    ...extra,
  };
}

/** A flow: start -> the plugin's node -> end. */
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

// ---------------------------------------------------------------------------
// A node, in process.
// ---------------------------------------------------------------------------

/** An in-process plugin whose node does whatever the test hands it. */
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
    // The config the spec wrote, not one heddle chose: a plugin that could
    // pick its own endpoint would make a submitted document unreadable as a
    // statement of where a run sends things.
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
      // Only temperature. `maxTokens` is the spec's and must survive, which is
      // what makes this a merge rather than a replacement — a plugin that had
      // to restate every default in order to change one would get it wrong.
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

    // A provider rebuilt per call is a token bucket that never fills and a
    // cache that never hits — the failure §7.6 names about `LLMExecutor`.
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
    // The operator's default endpoint is right there in `deps` and is not
    // reached for: an unnamed model is an error, never a fallback.
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

    // Not a separate path to the model: a plugin's call goes through the same
    // `createProvider` an agent's does, so `applyDefaultCredential`'s rule
    // about where the operator's key may travel applies to it unchanged.
    expect(built[0].options).toMatchObject({
      allowEnvRefs: false,
      defaultKey: 'operator-key',
      defaultUrl: 'https://operator.example',
    });
  });
});

// ---------------------------------------------------------------------------
// A transform, in process.
//
// Driven through `TransformChain` directly. What is under test is the context
// the chain builds, and a whole agent around it would only add a model call
// that is not the one being asserted on.
// ---------------------------------------------------------------------------

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
    // The asymmetry this closes: out of process a transform's `runTool` worked,
    // in process `TransformContext` did not offer one at all. A guardrail that
    // consults a classifier is the ordinary case, and which side of a process
    // boundary it runs on is not something its author chose.
    let ran: unknown;
    const chain = chainWith(
      async (ctx) => {
        ran = await ctx.runTool('classify', { text: 'hi' }).catch((err: Error) => err.message);
      },
      {},
    );

    await chain.apply('pre', [{ role: 'user', content: 'hi' }], undefined);

    // No registry is configured here, so what is asserted is that the verb
    // exists and reports heddle's own missing wiring — not `ctx.runTool is not
    // a function`, which is what this used to be.
    expect(String(ran)).toMatch(/no tool registry configured/);
    expect(String(ran)).toMatch(/LlmGuard "guard"/);
  });
});

// ---------------------------------------------------------------------------
// Out of process, where the verb is a frame on a pipe.
// ---------------------------------------------------------------------------

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
    // The whole ChatResponse crosses, not just its text: a plugin deciding
    // whether the model stopped or ran out of tokens needs the rest of it.
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
    // Refused before anything was built, which is the point of checking the
    // grant in `serve` rather than inside the handler.
    expect(built).toHaveLength(0);
    expect(chatCompletion).not.toHaveBeenCalled();
  });

  it('rejects a frame naming no call, because a model belongs to a component', async () => {
    // Hand-rolled, since the shipped runtime always names the call — this is
    // the case a plugin written against the raw protocol can reach.
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

  it('does not spend the plugin’s deadline on heddle’s own work', async () => {
    // The budget is a silence budget. A plugin blocked on `callModel` is not
    // silent — it is waiting on heddle, which knows exactly how long it has
    // kept it waiting. Without the hold, this is a plugin killed at 300ms for a
    // 700ms model call it did not make itself.
    chatCompletion.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ content: 'slow', finish_reason: 'stop' }), 700),
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
      { timeout: 300 },
    );

    expect(state.got).toBe('slow');
  });

  it('still kills a plugin that goes quiet after heddle has answered it', async () => {
    // The other half of the same rule: the hold is released when the reverse
    // call ends, so a plugin that stops answering afterwards is timed out
    // exactly as it would have been. A hold that leaked would make the per-call
    // budget unenforceable for any plugin that ever called the model.
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
        { timeout: 300 },
      ),
    ).rejects.toThrow(/did not answer execute within 300ms/);
  });
});
