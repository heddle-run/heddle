/**
 * What a *remote* plugin's reporting looks like over the wire. The reporting
 * semantics themselves — namespacing, attribution, ordering, the workspace's
 * lifetime — are pinned in-process by `context.test.ts`; what belongs here is
 * only what the wire adds: call attribution, silence budgets, capability
 * grants, and a sandboxed process's missing workspace.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { loadRemotePlugin } from '../remote-loader.js';
import { PluginRegistry } from '../registry.js';
import { createScratchWorkspace } from '../../workspace/index.js';
import { compile } from '../../graph/compile.js';
import { validate } from '../../graph/validate.js';
import { parseFlow } from '../../spec/parser.js';
import { Runner } from '../../runner/runner.js';
import { DEFAULT_RUNNER_OPTIONS } from '../../runner/options.js';
import type { Event } from '../../runner/events.js';
import type { SandboxSession } from '../../sandbox/types.js';
import { join } from 'node:path';
import {
  ALL_CAPABILITIES as ALL,
  flowUsing,
  manifest as baseManifest,
  useDisposal,
  useScratch,
} from './helpers/remote-plugin.js';

const scratch = useScratch('heddle-plugin-reporting-');
const open = useDisposal<PluginRegistry>();

function stubSession(): SandboxSession {
  return {
    name: 'stub',
    workspace: {
      root: scratch.path,
      bin: join(scratch.path, '.heddle', 'bin'),
      grants: () => [],
      toolPaths: () => [],
      dispose: () => {},
    },
    wrap: (toolPath, args) => ({
      command: toolPath,
      args: args ?? [],
      env: { HEDDLE_SANDBOX: '1' },
    }),
    dispose: () => {},
  };
}

const manifest = (
  componentType: string,
  capabilities: string[] = [],
  extra: Record<string, unknown> = {},
): Record<string, unknown> =>
  baseManifest(componentType, extra, capabilities, 'reporter-plugin');

interface Run {
  state: Record<string, unknown>;
  events: Event[];
}

async function run(
  componentType: string,
  entry: string,
  manifestData: unknown,
  flow: string = flowUsing(componentType),
  timeout = 5_000,
  session?: SandboxSession,
): Promise<Run> {
  const registry = PluginRegistry.empty();
  open.track(registry);
  registry.addRemote(
    loadRemotePlugin(manifestData, entry, { timeout, capabilities: ALL, session }),
  );

  const events: Event[] = [];
  const collect = (e: Event): void => {
    events.push(e);
  };

  const graph = compile(parseFlow(flow, registry), {
    plugins: registry,
    eventHandler: collect,
    scratchWorkspace: createScratchWorkspace,
  });
  validate(graph);

  const runner = new Runner(graph, {
    ...DEFAULT_RUNNER_OPTIONS,
    verbose: false,
    eventHandler: collect,
  });
  const state = await runner.run(undefined, { text: 'hello' });
  return { state: state.toData() as Record<string, unknown>, events };
}

function reported(events: Event[]): Event[] {
  return events.filter((e) => e.type.startsWith('plugin:') || e.type === 'plugin_log');
}

describe('a plugin emitting an event', () => {
  it('carries no data when the plugin sent none', async () => {
    const entry = scratch.writePlugin(
      'bare',
      `await callHost('emitEvent', { call: msg.id, name: 'started' });
       return { output: {} };`,
    );

    const { events } = await run('BareNode', entry, manifest('BareNode', ['emitEvent']));
    expect(reported(events)).toEqual([
      {
        type: 'plugin:BareNode:started',
        nodeName: 'p',
        nodeType: 'BareNode',
        data: undefined,
      },
    ]);
  });

  it('refuses an event that names no call', async () => {
    const entry = scratch.writePlugin(
      'unattributed',
      `try { await callHost('emitEvent', { name: 'step' });
             return { output: { err: 'none' } }; }
       catch (e) { return { output: { err: e.message } }; }`,
    );

    const { state, events } = await run(
      'UnattributedNode',
      entry,
      manifest('UnattributedNode', ['emitEvent']),
    );

    expect(String(state.err)).toMatch(/emitEvent needs a "call"/);
    expect(reported(events)).toEqual([]);
  });

  it('refuses an event naming a call it is not inside', async () => {
    const entry = scratch.writePlugin(
      'stray',
      `try { await callHost('emitEvent', { call: 4242, name: 'step' });
             return { output: { err: 'none' } }; }
       catch (e) { return { output: { err: e.message } }; }`,
    );

    const { state, events } = await run(
      'StrayNode',
      entry,
      manifest('StrayNode', ['emitEvent']),
    );

    expect(String(state.err)).toMatch(/named call 4242, which heddle is not waiting on/);
    expect(reported(events)).toEqual([]);
  });

  it('refuses an event naming one of heddle own lifecycle frames', async () => {
    const entry = scratch.writeRawPlugin(
      'lifecycle-forge',
      `let buf = '';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
let executing;
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  const lines = buf.split('\\n');
  buf = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'init') continue;
    if (msg.method === 'execute') {
      executing = msg.id;
      send({ id: 'forged', method: 'emitEvent', params: { call: 1, name: 'step' } });
      continue;
    }
    if (!msg.method && String(msg.id) === 'forged') {
      send({ id: executing, result: { output: {
        err: msg.error ? msg.error.message : 'none',
      } } });
    }
  }
});
`,
    );

    const { state, events } = await run(
      'LifecycleForgeNode',
      entry,
      manifest('LifecycleForgeNode', ['emitEvent']),
    );

    expect(String(state.err)).toMatch(/is not an execute or apply/);
    expect(String(state.err)).toMatch(/lifecycle frame heddle sent the plugin/);
    expect(String(state.err)).not.toMatch(/nowhere to report to/);
    expect(reported(events)).toEqual([]);
  });

  /**
   * What a plugin is given is a silence budget, not a deadline: every frame it
   * sends restarts the clock, so one that keeps reporting outlives the timeout
   * and one that goes quiet does not. Both halves are load-bearing, and this is
   * the one a loaded machine can make look broken.
   *
   * Two margins hold the instrument up, and both are wide on purpose.
   *
   * The budget has to cover starting the plugin, because the clock is armed
   * when the call is written and the child process does not exist yet. Node
   * takes about 40ms to reach its first line here, and about 90ms on a machine
   * with three times more runnable processes than cores, so a budget of 1000ms
   * leaves an order of magnitude.
   *
   * Every later window has to cover one reporting interval, and 1000ms against
   * 25ms is forty to one: a tick would have to arrive forty times later than it
   * was asked for before it looked like silence.
   *
   * The loop is bounded by the plugin's own clock rather than by a count of
   * sleeps, which is what the earlier version got wrong — nine sleeps of 100ms
   * against a 300ms budget held only while each sleep stayed inside a third of
   * it, and on a loaded machine the first one did not, so the test measured the
   * machine rather than the mechanism. How many ticks land no longer matters:
   * any report inside the window restarts the clock, and the plugin does not
   * return until its own clock says it has outlived the budget it was given.
   */
  it('keeps the call alive for as long as it keeps reporting', async () => {
    const budget = 1_000;
    const entry = scratch.writePlugin(
      'slow',
      `const stop = Date.now() + ${budget * 1.2};
       let ticks = 0;
       while (Date.now() < stop) {
         await sleep(25);
         await callHost('emitEvent', { call: msg.id, name: 'tick', data: { i: ticks++ } });
       }
       return { output: { finished: true, ticks } };`,
    );

    const started = Date.now();
    const { state, events } = await run(
      'SlowNode',
      entry,
      manifest('SlowNode', ['emitEvent']),
      flowUsing('SlowNode'),
      budget,
    );

    expect(state).toMatchObject({ finished: true });
    expect(state.ticks).toBeGreaterThan(1);
    // Every tick the plugin sent reached the run stream, whatever the count was.
    expect(reported(events)).toHaveLength(state.ticks as number);
    expect(Date.now() - started).toBeGreaterThan(budget);
  });
});

describe('a plugin logging', () => {
  it('refuses a level heddle has no meaning for', async () => {
    const entry = scratch.writePlugin(
      'shouty',
      `try { await callHost('log', { call: msg.id, level: 'FATAL', message: 'x' });
             return { output: { err: 'none' } }; }
       catch (e) { return { output: { err: e.message } }; }`,
    );

    const { state, events } = await run(
      'ShoutyNode',
      entry,
      manifest('ShoutyNode', ['log']),
    );

    expect(String(state.err)).toMatch(
      /log needs a "level", one of: debug, info, warn, error/,
    );
    expect(reported(events)).toEqual([]);
  });

  it('refuses a log with no message, and says where a payload belongs', async () => {
    const entry = scratch.writePlugin(
      'payload',
      `try { await callHost('log', { call: msg.id, level: 'info', message: { rows: 3 } });
             return { output: { err: 'none' } }; }
       catch (e) { return { output: { err: e.message } }; }`,
    );

    const { state } = await run('PayloadNode', entry, manifest('PayloadNode', ['log']));
    expect(String(state.err)).toMatch(/A structured payload belongs on emitEvent/);
  });
});

describe('capabilities on the reporting verbs', () => {
  it('refuses an emitEvent the manifest never declared, naming the capability', async () => {
    const entry = scratch.writePlugin(
      'undeclared',
      `try { await callHost('emitEvent', { call: msg.id, name: 'step' });
             return { output: { err: 'none' } }; }
       catch (e) { return { output: { err: e.message } }; }`,
    );

    const { state, events } = await run('UndeclaredNode', entry, manifest('UndeclaredNode'));

    expect(String(state.err)).toMatch(/"emitEvent" is not granted to this plugin/);
    expect(String(state.err)).toMatch(/Add it to "capabilities" in the manifest/);
    expect(reported(events)).toEqual([]);
  });

  it('refuses a log the manifest never declared', async () => {
    const entry = scratch.writePlugin(
      'undeclared-log',
      `try { await callHost('log', { call: msg.id, level: 'info', message: 'hi' });
             return { output: { err: 'none' } }; }
       catch (e) { return { output: { err: e.message } }; }`,
    );

    const { state, events } = await run(
      'UndeclaredLogNode',
      entry,
      manifest('UndeclaredLogNode'),
    );

    expect(String(state.err)).toMatch(/"log" is not granted to this plugin/);
    expect(reported(events)).toEqual([]);
  });

  it('grants each verb on its own', async () => {
    const entry = scratch.writePlugin(
      'eventonly',
      `await callHost('emitEvent', { call: msg.id, name: 'step' });
       try { await callHost('log', { call: msg.id, level: 'info', message: 'hi' });
             return { output: { err: 'none' } }; }
       catch (e) { return { output: { err: e.message } }; }`,
    );

    const { state, events } = await run(
      'EventOnlyNode',
      entry,
      manifest('EventOnlyNode', ['emitEvent']),
    );

    expect(String(state.err)).toMatch(/"log" is not granted/);
    expect(reported(events).map((e) => e.type)).toEqual(['plugin:EventOnlyNode:step']);
  });

  it('refuses at load a reporting capability the host does not grant', () => {
    const entry = scratch.writePlugin('ungranted', `return { output: {} };`);
    expect(() =>
      loadRemotePlugin(manifest('UngrantedNode', ['emitEvent']), entry, {
        capabilities: ['runTool'],
      }),
    ).toThrow(/requests "emitEvent", which this host does not grant/);
  });

  it('lists the reporting verbs among what heddle serves', () => {
    const entry = scratch.writePlugin('bogus', `return { output: {} };`);
    expect(() =>
      loadRemotePlugin(manifest('BogusNode', ['emitEvents']), entry, { capabilities: ALL }),
    ).toThrow(/It serves: runTool, emitEvent, log/);
  });
});

describe('the workspace a node is given', () => {
  it('arrives with the request and is writable', async () => {
    const entry = scratch.writePlugin(
      'writer',
      `const { writeFileSync } = await import('node:fs');
       writeFileSync(msg.params.workspace + '/note.txt', 'hello');
       return { output: { dir: msg.params.workspace } };`,
    );

    const { state } = await run('WriterNode', entry, manifest('WriterNode'));

    expect(typeof state.dir).toBe('string');
    expect(existsSync(state.dir as string)).toBe(false);
  });

  it('needs no capability, because it is not a call into heddle', async () => {
    const entry = scratch.writePlugin(
      'nogrant',
      `return { output: { got: typeof msg.params.workspace } };`,
    );
    const { state } = await run('NoGrantNode', entry, manifest('NoGrantNode'));
    expect(state.got).toBe('string');
  });

  it('is withheld when the plugin process is confined to a sandbox of its own', async () => {
    const entry = scratch.writePlugin(
      'confined',
      `return { output: {
         got: typeof msg.params.workspace,
         why: String(msg.params.workspaceUnavailable),
       } };`,
    );

    const { state } = await run(
      'ConfinedNode',
      entry,
      manifest('ConfinedNode'),
      flowUsing('ConfinedNode'),
      5_000,
      stubSession(),
    );

    expect(state.got).toBe('undefined');
    expect(state.why).toBe('confined');
  });

  it('fails getWorkspace naming the sandbox, not transforms', async () => {
    const entry = scratch.writeHelperPlugin(
      'confined-helper',
      `serve({
         ConfinedHelperNode: {
           execute(input, ctx) {
             try { return { output: { dir: ctx.getWorkspace() } }; }
             catch (e) { return { output: { err: e.message } }; }
           },
         },
       });`,
    );

    const { state } = await run(
      'ConfinedHelperNode',
      entry,
      manifest('ConfinedHelperNode'),
      flowUsing('ConfinedHelperNode'),
      5_000,
      stubSession(),
    );

    expect(String(state.err)).toMatch(/runs inside a sandbox of its own/);
    expect(String(state.err)).not.toMatch(/transform/);
  });
});

function agentFlowWithTransform(componentType: string): string {
  return JSON.stringify({
    component_type: 'Flow',
    name: 'guarded',
    start_node: { $component_ref: 's' },
    nodes: [{ $component_ref: 's' }, { $component_ref: 'a' }, { $component_ref: 'e' }],
    control_flow_connections: [
      {
        component_type: 'ControlFlowEdge',
        name: 'x',
        from_node: { $component_ref: 's' },
        to_node: { $component_ref: 'a' },
      },
      {
        component_type: 'ControlFlowEdge',
        name: 'y',
        from_node: { $component_ref: 'a' },
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
      a: {
        component_type: 'AgentNode',
        id: 'a',
        name: 'agent_node',
        agent: {
          component_type: 'Agent',
          id: 'ia',
          name: 'the_agent',
          system_prompt: 'be helpful',
          llm_config: {
            component_type: 'OpenAiConfig',
            id: 'l',
            name: 'l',
            model_id: 'gpt-4o',
            url: 'http://127.0.0.1:9/unreachable',
            api_key: 'not-a-real-key',
          },
          tools: [],
          transforms: [{ component_type: componentType, id: 't', name: 'guard' }],
        },
      },
      e: { component_type: 'EndNode', id: 'e', name: 'e' },
    },
  });
}

function transformManifest(componentType: string, capabilities: string[] = []) {
  return {
    name: 'reporter-plugin',
    version: '1.0.0',
    capabilities,
    components: [{ componentType, kind: 'transform', phase: 'pre' }],
  };
}

describe('the inlined runtime helper', () => {
  it('reports through ctx, without the author naming a call', async () => {
    const entry = scratch.writeHelperPlugin(
      'helper-report',
      `serve({
         Helper: {
           execute: (input, ctx) => {
             ctx.emitEvent('step', { at: 1 });
             ctx.log('debug', 'halfway');
             return { output: { ok: true } };
           },
         },
       });`,
    );

    const { state, events } = await run(
      'Helper',
      entry,
      manifest('Helper', ['emitEvent', 'log']),
    );

    expect(state).toMatchObject({ ok: true });
    expect(reported(events)).toEqual([
      { type: 'plugin:Helper:step', nodeName: 'p', nodeType: 'Helper', data: { at: 1 } },
      {
        type: 'plugin_log',
        nodeName: 'p',
        nodeType: 'Helper',
        level: 'debug',
        message: 'halfway',
      },
    ]);
  });

  it('throws at the call when the name is unusable', async () => {
    const entry = scratch.writeHelperPlugin(
      'helper-badname',
      `serve({
         BadName: {
           execute: (input, ctx) => {
             try { ctx.emitEvent('not a name'); return { output: { err: 'none' } }; }
             catch (e) { return { output: { err: e.message } }; }
           },
         },
       });`,
    );

    const { state, events } = await run(
      'BadName',
      entry,
      manifest('BadName', ['emitEvent']),
    );
    expect(String(state.err)).toMatch(/is not a usable event name/);
    expect(reported(events)).toEqual([]);
  });

  it('throws at the call when the capability was never declared', async () => {
    const entry = scratch.writeHelperPlugin(
      'helper-ungranted',
      `serve({
         Silent: {
           execute: (input, ctx) => {
             try { ctx.emitEvent('step'); return { output: { err: 'none' } }; }
             catch (e) { return { output: { err: e.message } }; }
           },
         },
       });`,
    );

    const { state } = await run('Silent', entry, manifest('Silent'));
    expect(String(state.err)).toMatch(/emitEvent is not granted to this plugin/);
    expect(String(state.err)).toMatch(/Add it to "capabilities" in the manifest/);
  });

  it('hands a node the workspace heddle sent it', async () => {
    const entry = scratch.writeHelperPlugin(
      'helper-workspace',
      `import { writeFileSync } from 'node:fs';
       serve({
         Scratch: {
           execute: (input, ctx) => {
             const dir = ctx.getWorkspace();
             writeFileSync(dir + '/note.txt', 'hello');
             return { output: { dir, same: dir === ctx.getWorkspace() } };
           },
         },
       });`,
    );

    const { state } = await run('Scratch', entry, manifest('Scratch'));
    expect(typeof state.dir).toBe('string');
    expect(state.same).toBe(true);
    expect(existsSync(state.dir as string)).toBe(false);
  });

  it('tells a transform why it has no workspace', async () => {
    const entry = scratch.writeHelperPlugin(
      'helper-transform-workspace',
      `serve({
         NoScratch: {
           apply: (messages, ctx) => {
             try { ctx.getWorkspace(); return { action: 'pass' }; }
             catch (e) { return { action: 'reject', reason: e.message }; }
           },
         },
       });`,
    );

    const { state } = await run(
      'NoScratch',
      entry,
      transformManifest('NoScratch'),
      agentFlowWithTransform('NoScratch'),
    );

    expect(String(state.transform_reason)).toMatch(/A transform owns no tool scope/);
  });
});
