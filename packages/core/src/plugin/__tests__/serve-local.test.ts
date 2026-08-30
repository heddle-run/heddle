/**
 * The in-process plugin host: `servePlugin` over `LocalPluginHost`.
 *
 * The subprocess suite (`remote.test.ts`) proves the stdio transport; this one
 * proves the same conversation with the pipe removed. The entry source is
 * evaluated with `serve` injected — `new Function('serve', source)(serve)` —
 * exactly as `servePlugin`'s contract asks, and the dispatch behind it is the
 * one `makeServe` body both transports share. The conformance test at the
 * bottom holds the two hosts together: one fixture, both transports, identical
 * results and identical error text.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { compile } from '../../graph/compile.js';
import { validate } from '../../graph/validate.js';
import type { Dependencies } from '../../node/types.js';
import { DEFAULT_RUNNER_OPTIONS } from '../../runner/options.js';
import { Runner } from '../../runner/runner.js';
import { parseFlow } from '../../spec/parser.js';
import { createScratchWorkspace } from '../../workspace/index.js';
import type { PluginCaller } from '../host.js';
import { validateManifest } from '../manifest.js';
import type { ExecuteParams } from '../protocol.js';
import { PluginRegistry } from '../registry.js';
import { loadRemotePlugin } from '../remote-loader.js';
import type { Seam } from '../seams.js';
import type { ServeFn } from '../serve-impl.js';
import {
  localPlugin,
  servePlugin,
  type LocalPlugin,
  type LocalPluginServices,
} from '../serve-local.js';
import type { MiddlewareContext } from '../types.js';
import {
  ALL_CAPABILITIES,
  flowUsing,
  manifest,
  useDisposal,
  useScratch,
} from './helpers/remote-plugin.js';

const scratch = useScratch('heddle-serve-local-');
const open = useDisposal();

const NO_DEPS = {} as Dependencies;

/**
 * A register function that evaluates the entry the way `servePlugin`'s doc
 * comment says to: a single-file, import-free source with `serve` injected.
 * `extras` are further injected globals, for fixtures that need to talk back
 * to the test without the protocol's help.
 */
function evaluating(
  source: string,
  extras: Record<string, unknown> = {},
): (serve: ServeFn) => void {
  return (serve) => {
    new Function('serve', ...Object.keys(extras), source)(
      serve,
      ...Object.values(extras),
    );
  };
}

function localFrom(
  raw: unknown,
  source: string,
  services?: LocalPluginServices,
  extras?: Record<string, unknown>,
): LocalPlugin {
  const loaded = localPlugin(
    validateManifest(raw),
    evaluating(source, extras),
    services,
  );
  open.track(loaded.host);
  return loaded;
}

async function runLocalFlow(
  componentType: string,
  source: string,
  manifestData: unknown,
  inputs: Record<string, unknown> = { text: 'hello' },
): Promise<Record<string, unknown>> {
  const plugin = servePlugin(validateManifest(manifestData), evaluating(source));
  const registry = PluginRegistry.fromPlugins([plugin]);

  const pf = parseFlow(flowUsing(componentType), registry);
  const graph = compile(pf, {
    plugins: registry,
    scratchWorkspace: createScratchWorkspace,
  });
  validate(graph);

  const runner = new Runner(graph, { ...DEFAULT_RUNNER_OPTIONS, verbose: false });
  const state = await runner.run(undefined, inputs);
  return state.toData() as Record<string, unknown>;
}

function executeParams(
  componentType: string,
  input: Record<string, unknown> = {},
): ExecuteParams {
  return {
    componentType,
    node: { componentType, name: 'p' },
    input,
    workspace: scratch.path,
  };
}

interface SeamProbe {
  ctx: MiddlewareContext;
  events: Array<{ name: string; data: unknown }>;
  logs: Array<{ level: string; message: string }>;
}

/** A stub MiddlewareContext capturing what the middleware reports through it. */
function seamCtx(seam: Seam): SeamProbe {
  const events: SeamProbe['events'] = [];
  const logs: SeamProbe['logs'] = [];

  return {
    events,
    logs,
    ctx: {
      seam,
      component: {},
      attempt: 1,
      maxAttempts: 1,
      signal: undefined,
      emitEvent: (name, data) => {
        events.push({ name, data });
      },
      log: (level, message) => {
        logs.push({ level, message });
      },
      runTool: () => Promise.reject(new Error('no tools in this test')),
      callModel: () => Promise.reject(new Error('no model in this test')),
    },
  };
}

describe('a node served in-process', () => {
  const CHOOSER = `serve({
    ChooserNode: {
      async execute(input) {
        return { output: { chose: input.text }, branch: input.text };
      },
    },
  });`;

  it('executes and returns its output', async () => {
    const state = await runLocalFlow(
      'ShoutNode',
      `serve({
         ShoutNode: {
           async execute(input) {
             return { output: { shouted: String(input.text).toUpperCase() } };
           },
         },
       });`,
      manifest('ShoutNode'),
    );
    expect(state.shouted).toBe('HELLO');
  });

  it('accepts a branch the manifest declares', async () => {
    const state = await runLocalFlow(
      'ChooserNode',
      CHOOSER,
      manifest('ChooserNode', { branches: ['left', 'right'] }),
      { text: 'left' },
    );
    expect(state.chose).toBe('left');
  });

  it('refuses a branch the manifest did not declare', async () => {
    await expect(
      runLocalFlow(
        'ChooserNode',
        CHOOSER,
        manifest('ChooserNode', { branches: ['left', 'right'] }),
        { text: 'sideways' },
      ),
    ).rejects.toThrow(
      /returned branch "sideways", which is not in its declared branches \[left, right\]/,
    );
  });

  it('refuses any branch from a node that declared none', async () => {
    await expect(
      runLocalFlow('ChooserNode', CHOOSER, manifest('ChooserNode'), {
        text: 'left',
      }),
    ).rejects.toThrow(/not in its declared branches \[\]/);
  });

  it('surfaces an error thrown inside the handler', async () => {
    await expect(
      runLocalFlow(
        'BoomNode',
        `serve({
           BoomNode: {
             async execute() {
               throw new Error('deliberate in-process failure');
             },
           },
         });`,
        manifest('BoomNode'),
      ),
    ).rejects.toThrow(/deliberate in-process failure/);
  });

  it('rejects a result that is not { output }', async () => {
    await expect(
      runLocalFlow(
        'BadNode',
        `serve({
           BadNode: {
             async execute() {
               return { nope: true };
             },
           },
         });`,
        manifest('BadNode'),
      ),
    ).rejects.toThrow(/returned no "output" object/);
  });
});

describe('a middleware served in-process', () => {
  const GATE_MANIFEST = {
    name: 'gate-plugin',
    version: '1.0.0',
    components: [
      {
        componentType: 'GateKeeper',
        kind: 'middleware',
        seams: { toolCall: ['before', 'after'] },
      },
    ],
  };

  const GATE_SOURCE = `serve({
    GateKeeper: {
      toolCall: {
        before({ subject, input }) {
          if (input.command === 'halt') {
            return { action: 'reject', reason: 'halted by the gate' };
          }
          return {
            action: 'modify',
            input: Object.assign({}, input, { inspected: subject.toolName }),
          };
        },
        after({ outcome }) {
          if (!outcome.ok) {
            return { action: 'fail', reason: 'saw: ' + outcome.error.message };
          }
          return { action: 'pass' };
        },
      },
    },
  });`;

  function gate() {
    const { plugin } = localFrom(GATE_MANIFEST, GATE_SOURCE);
    return plugin.middleware![0].createMiddleware({}, NO_DEPS);
  }

  it('round-trips before verdicts through createMiddleware', async () => {
    const mw = gate();
    const { ctx } = seamCtx('toolCall');

    await expect(
      mw.before!(
        { subject: { toolName: 'shell' }, input: { command: 'ls' } },
        ctx,
      ),
    ).resolves.toEqual({
      action: 'modify',
      input: { command: 'ls', inspected: 'shell' },
    });

    await expect(
      mw.before!(
        { subject: { toolName: 'shell' }, input: { command: 'halt' } },
        ctx,
      ),
    ).resolves.toEqual({ action: 'reject', reason: 'halted by the gate' });
  });

  it('round-trips after verdicts through createMiddleware', async () => {
    const mw = gate();
    const { ctx } = seamCtx('toolCall');

    await expect(
      mw.after(
        { subject: { toolName: 'shell' }, outcome: { ok: true, value: {} } },
        ctx,
      ),
    ).resolves.toEqual({ action: 'pass' });

    await expect(
      mw.after(
        {
          subject: { toolName: 'shell' },
          outcome: {
            ok: false,
            error: { name: 'Error', message: 'tool blew up' },
          },
        },
        ctx,
      ),
    ).resolves.toEqual({ action: 'fail', reason: 'saw: tool blew up' });
  });
});

describe('reverse calls in-process', () => {
  const REPORTER_MANIFEST = manifest('ReporterNode', {}, [
    'runTool',
    'emitEvent',
    'log',
  ]);

  const REPORTER_SOURCE = `serve({
    ReporterNode: {
      async execute(input, ctx) {
        const tool = await ctx.runTool('echo', { v: input.text });
        ctx.emitEvent('progress', { step: 1 });
        ctx.log('info', 'reporting in');
        return { output: { fromTool: tool.echoed } };
      },
    },
  });`;

  it('routes ctx.runTool / ctx.emitEvent / ctx.log to the host services', async () => {
    const toolCalls: Array<{
      call: string;
      name: string;
      input: Record<string, unknown>;
    }> = [];
    const events: Array<{ name: string; data: unknown }> = [];
    const logs: Array<{ level: string; message: string }> = [];

    const { host } = localFrom(REPORTER_MANIFEST, REPORTER_SOURCE, {
      runTool: async (call, name, input) => {
        toolCalls.push({ call, name, input });
        return { echoed: `tool saw ${String(input.v)}` };
      },
      onEvent: (name, data) => events.push({ name, data }),
      onLog: (level, message) => logs.push({ level, message }),
    });

    const result = await host.call(
      'execute',
      executeParams('ReporterNode', { text: 'ping' }),
    );

    expect(result).toEqual({ output: { fromTool: 'tool saw ping' } });
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ name: 'echo', input: { v: 'ping' } });
    expect(events).toEqual([{ name: 'progress', data: { step: 1 } }]);
    expect(logs).toEqual([{ level: 'info', message: 'reporting in' }]);
  });

  it('prefers the wiring a call brings over the host services, as PluginHost does', async () => {
    const serviceTouches: string[] = [];
    const events: Array<{ name: string; data: unknown }> = [];
    const logs: string[] = [];

    const { host } = localFrom(REPORTER_MANIFEST, REPORTER_SOURCE, {
      runTool: async () => {
        serviceTouches.push('runTool');
        return { echoed: 'from the services' };
      },
      onEvent: () => serviceTouches.push('onEvent'),
      onLog: () => serviceTouches.push('onLog'),
    });

    const result = await host.call(
      'execute',
      executeParams('ReporterNode', { text: 'ping' }),
      {
        runTool: async (name, input) => ({
          echoed: `per-call ${String(input.v)}`,
        }),
        reporter: {
          emitEvent: (name, data) => {
            events.push({ name, data });
          },
          log: (level, message) => {
            logs.push(`${level} ${message}`);
          },
        },
      },
    );

    expect(result).toEqual({ output: { fromTool: 'per-call ping' } });
    expect(serviceTouches).toEqual([]);
    expect(events).toEqual([{ name: 'progress', data: { step: 1 } }]);
    expect(logs).toEqual(['info reporting in']);
  });
});

describe('capabilities in-process', () => {
  it('refuses a reverse call the manifest never declared, naming the grant', async () => {
    const { host } = localFrom(
      manifest('QuietNode'),
      `serve({
         QuietNode: {
           async execute(input, ctx) {
             ctx.emitEvent('progress', {});
             return { output: {} };
           },
         },
       });`,
    );

    await expect(
      host.call('execute', executeParams('QuietNode')),
    ).rejects.toThrow(
      /emitEvent is not granted to this plugin\. Add it to "capabilities" in the manifest/,
    );
  });

  it('validates an event name with the subprocess runtime message', async () => {
    const { host } = localFrom(
      manifest('NoisyNode', {}, ['emitEvent']),
      `serve({
         NoisyNode: {
           async execute(input, ctx) {
             ctx.emitEvent('bad name!', {});
             return { output: {} };
           },
         },
       });`,
    );

    const call = host.call('execute', executeParams('NoisyNode'));
    await expect(call).rejects.toThrow(/"bad name!" is not a usable event name/);
    await expect(call).rejects.toThrow(/plugin:<componentType>:<name>/);
  });
});

describe('cancelling an in-process call', () => {
  it('settles the call as PluginHost would, and aborts the handler signal', async () => {
    let begin!: () => void;
    const begun = new Promise<void>((resolve) => {
      begin = resolve;
    });
    let observe!: (aborted: boolean) => void;
    const observed = new Promise<boolean>((resolve) => {
      observe = resolve;
    });

    const { host } = localFrom(
      manifest('SlowNode'),
      `serve({
         SlowNode: {
           execute(input, ctx) {
             probe.begun();
             return new Promise((resolve) => {
               ctx.signal.addEventListener('abort', () => {
                 probe.aborted(ctx.signal.aborted);
                 resolve({ output: { finished: 'too late' } });
               });
             });
           },
         },
       });`,
      undefined,
      {
        probe: {
          begun: () => begin(),
          aborted: (flag: boolean) => observe(flag),
        },
      },
    );

    const controller = new AbortController();
    const call = host.call('execute', executeParams('SlowNode'), {
      signal: controller.signal,
    });
    const failure = expect(call).rejects.toThrow(
      'plugin "test-plugin" was still in execute when the run ended',
    );

    await begun;
    controller.abort();

    await failure;
    await expect(observed).resolves.toBe(true);
  });
});

describe('conformance with the subprocess host', () => {
  const CONFORMANCE_MANIFEST = {
    name: 'conformance-plugin',
    version: '1.0.0',
    capabilities: ['runTool', 'emitEvent'],
    components: [{ componentType: 'EchoNode' }, { componentType: 'BoomNode' }],
  };

  const CONFORMANCE_ENTRY = `serve({
    EchoNode: {
      async execute(input, ctx) {
        const tool = await ctx.runTool('echo', { v: input.text });
        ctx.emitEvent('progress', { text: input.text });
        return { output: { echoed: input.text, viaTool: tool.echoed } };
      },
    },
    BoomNode: {
      async execute() {
        throw new Error('deliberate conformance failure');
      },
    },
  });`;

  interface Driven {
    result: unknown;
    events: Array<{ name: string; data: unknown }>;
    failure: string;
  }

  async function drive(host: PluginCaller): Promise<Driven> {
    const events: Driven['events'] = [];
    const options = {
      reporter: {
        emitEvent: (name: string, data?: unknown) => {
          events.push({ name, data });
        },
        log: () => {},
      },
      runTool: async (name: string, input: Record<string, unknown>) => ({
        echoed: `${name} saw ${String(input.v)}`,
      }),
    };

    const result = await host.call(
      'execute',
      executeParams('EchoNode', { text: 'round trip' }),
      options,
    );
    const failure = await host
      .call('execute', executeParams('BoomNode'), options)
      .then(
        () => 'resolved',
        (err: Error) => err.message,
      );

    return { result, events, failure };
  }

  // A real node child is spawned for the stdio half, so this test gets the
  // budget a subprocess needs on a busy machine rather than vitest's default.
  it('answers identically over stdio and in-process', { timeout: 30_000 }, async () => {
    const entry = scratch.writeHelperPlugin('conformance', CONFORMANCE_ENTRY);
    const remote = loadRemotePlugin(CONFORMANCE_MANIFEST, entry, {
      timeout: 20_000,
      capabilities: [...ALL_CAPABILITIES],
    });
    open.track(remote.host);
    const local = localFrom(CONFORMANCE_MANIFEST, CONFORMANCE_ENTRY);

    const overPipe = await drive(remote.host);
    const inProcess = await drive(local.host);

    expect(overPipe.result).toEqual({
      output: { echoed: 'round trip', viaTool: 'echo saw round trip' },
    });
    expect(overPipe.events).toEqual([
      { name: 'progress', data: { text: 'round trip' } },
    ]);
    expect(overPipe.failure).toBe(
      'plugin "conformance-plugin": deliberate conformance failure',
    );

    expect(inProcess).toEqual(overPipe);
  });
});

describe('the coding-agent library plugin, in-process', () => {
  const LIBRARY = '../../../../../library/coding-agent/';

  function codex(componentType: string, config: Record<string, unknown> = {}) {
    const raw = JSON.parse(
      readFileSync(new URL(`${LIBRARY}plugin.json`, import.meta.url), 'utf-8'),
    ) as unknown;
    const source = readFileSync(
      new URL(`${LIBRARY}plugin.mjs`, import.meta.url),
      'utf-8',
    );

    const { plugin } = localFrom(raw, source);
    const def = plugin.middleware!.find(
      (candidate) => candidate.componentType === componentType,
    )!;
    return def.createMiddleware(config, NO_DEPS);
  }

  it('CodexContextWindow trims an oversized conversation at modelCall.before', async () => {
    const mw = codex('CodexContextWindow', { auto_compact_limit_chars: 5000 });
    const { ctx, events, logs } = seamCtx('modelCall');

    const messages = [
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'do the task' },
    ];
    for (let i = 1; i <= 8; i++) {
      messages.push({
        role: 'assistant',
        content: `working on step ${i} ${'x'.repeat(400)}`,
      });
      messages.push({
        role: 'tool',
        content: `output of step ${i} ${'y'.repeat(400)}`,
      });
    }
    messages.push({ role: 'user', content: 'now finish up' });
    expect(JSON.stringify(messages).length).toBeGreaterThan(5000);

    const verdict = await mw.before!(
      { subject: { nodeName: 'coder' }, input: { messages } },
      ctx,
    );

    expect(verdict.action).toBe('modify');
    const kept = (
      verdict as unknown as {
        input: { messages: Array<{ role: string; content: string }> };
      }
    ).input.messages;

    // Every system and user message survives, in order.
    const durable = (list: Array<{ role: string; content: string }>) =>
      list.filter(
        (message) =>
          message.role === 'system' ||
          (message.role === 'user' &&
            !message.content.startsWith('[context compacted]')),
      );
    expect(durable(kept)).toEqual(durable(messages));

    // One bridge message marks the cut and counts what went.
    const bridge = kept.find((message) =>
      message.content.startsWith('[context compacted]'),
    );
    const dropped = messages.length - (kept.length - 1);
    expect(dropped).toBeGreaterThan(0);
    expect(bridge?.role).toBe('user');
    expect(bridge?.content).toContain(`(${dropped} messages)`);

    // Rounds go oldest first and whole: no tool output without its assistant.
    expect(kept.some((m) => m.content.includes('working on step 8'))).toBe(true);
    expect(kept.some((m) => m.content.includes('working on step 1'))).toBe(false);
    for (let i = 1; i <= 8; i++) {
      if (kept.some((m) => m.content.includes(`output of step ${i}`))) {
        expect(
          kept.some((m) => m.content.includes(`working on step ${i}`)),
        ).toBe(true);
      }
    }

    expect(events).toEqual([
      { name: 'compacted', data: { dropped, limit: 5000 } },
    ]);
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe('info');
    expect(logs[0].message).toContain('"coder" outgrew 5000 chars');
    expect(logs[0].message).toContain(`dropped ${dropped}`);
  });

  it('CodexContextWindow leaves a conversation under the limit alone', async () => {
    const mw = codex('CodexContextWindow', { auto_compact_limit_chars: 5000 });
    const { ctx, events } = seamCtx('modelCall');

    const verdict = await mw.before!(
      {
        subject: { nodeName: 'coder' },
        input: { messages: [{ role: 'user', content: 'hi' }] },
      },
      ctx,
    );

    expect(verdict).toEqual({ action: 'proceed' });
    expect(events).toEqual([]);
  });

  it('CodexApprovals lets a known-safe command through', async () => {
    const mw = codex('CodexApprovals');
    const { ctx, events } = seamCtx('toolCall');

    const verdict = await mw.before!(
      {
        subject: { toolName: 'shell_command' },
        input: { command: 'git status && ls -la' },
      },
      ctx,
    );

    expect(verdict).toEqual({ action: 'proceed' });
    expect(events).toEqual([]);
  });

  it('CodexApprovals suspends on a dangerous command, then honours the approval once', async () => {
    const mw = codex('CodexApprovals');
    const { ctx, events } = seamCtx('toolCall');
    const request = {
      subject: { toolName: 'shell_command' },
      input: { command: 'sudo rm -rf /tmp/cache' },
    };

    const first = await mw.before!(request, ctx);
    expect(first.action).toBe('suspend');
    const ask = (first as { ask: Record<string, unknown> }).ask;
    expect(String(ask.question)).toMatch(/Codex would flag/);
    expect(ask.command).toBe('sudo rm -rf /tmp/cache');
    expect(events).toEqual([
      {
        name: 'approval_requested',
        data: { command: 'sudo rm -rf /tmp/cache', dangerous: true },
      },
    ]);

    // The model re-issues the identical call after a "yes": through once…
    await expect(mw.before!(request, ctx)).resolves.toEqual({
      action: 'proceed',
    });
    // …and the approval is spent, so the next copy asks again.
    const third = await mw.before!(request, ctx);
    expect(third.action).toBe('suspend');
  });
});
