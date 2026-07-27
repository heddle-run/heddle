/**
 * What an out-of-process plugin can say while it runs, and what it cannot.
 *
 * The in-process half of this is `context.test.ts`. These are the same three
 * claims made about a plugin that heddle does not share a heap with, where none
 * of them are true by construction any more: the event type is minted on one
 * side of a pipe from a name written on the other, the capability check is the
 * only thing between a stranger's process and a client's stream, and the node an
 * event is attributed to is not on the stack when the frame arrives.
 *
 * The fixtures hand-roll the protocol rather than using the inlined `serve()`
 * helper, as `remote.test.ts` does and for the same reason: a rule the helper
 * enforces on heddle's behalf is not a rule, it is a courtesy. The helper gets
 * its own block at the end, where what is asserted is the courtesy.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRemotePlugin } from '../remote-loader.js';
import { withRuntime } from '../runtime-source.js';
import { PluginRegistry } from '../registry.js';
import { compile } from '../../graph/compile.js';
import { validate } from '../../graph/validate.js';
import { parseFlow } from '../../spec/parser.js';
import { Runner } from '../../runner/runner.js';
import { DEFAULT_RUNNER_OPTIONS } from '../../runner/options.js';
import type { Event } from '../../runner/events.js';
import type { PluginCapability } from '../protocol.js';
import type { SandboxSession } from '../../sandbox/types.js';

let scratch: string;
const open: PluginRegistry[] = [];

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'heddle-plugin-reporting-'));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

afterEach(() => {
  while (open.length) open.pop()!.dispose();
});

/**
 * The protocol, plus the one thing these fixtures need that `remote.test.ts`
 * does not: a way to make a reverse call and wait for the answer.
 *
 * Waiting is what most of these assert on. `emitEvent` and `log` return nothing
 * to a plugin author, so the only way a test can see heddle refusing one is to
 * hold the response — which is also the difference between a check that runs
 * and a check whose failure nobody would notice.
 */
const PREAMBLE = `
let buf = '';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const waiting = new Map();
let nextId = 0;
const callHost = (method, params) => new Promise((res, rej) => {
  const id = 'h' + nextId++;
  waiting.set(id, { res, rej });
  send({ id, method, params });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.stdin.setEncoding('utf-8');
process.stdin.on('data', async (chunk) => {
  buf += chunk;
  const lines = buf.split('\\n');
  buf = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (!msg.method) {
      const p = waiting.get(String(msg.id));
      if (p) { waiting.delete(String(msg.id));
        msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result); }
      continue;
    }
    try { send({ id: msg.id, result: await handle(msg) }); }
    catch (e) { send({ id: msg.id, error: { message: String(e && e.message || e) } }); }
  }
});
`;

function writePlugin(name: string, handleBody: string): string {
  const entry = join(scratch, `${name}.mjs`);
  writeFileSync(entry, `${PREAMBLE}\nasync function handle(msg) {\n${handleBody}\n}\n`);
  return entry;
}

/** Write a plugin against the inlined `serve()` helper. */
function writeHelperPlugin(name: string, source: string): string {
  const entry = join(scratch, `${name}.mjs`);
  writeFileSync(entry, withRuntime(source));
  return entry;
}

/**
 * Write a plugin that brings its own read loop.
 *
 * For the fixtures that have to *not* answer something. {@link PREAMBLE}
 * answers every request it is handed, `init` included, which is the one thing a
 * test about heddle's lifecycle frames cannot have it do.
 */
function writeRawPlugin(name: string, source: string): string {
  const entry = join(scratch, `${name}.mjs`);
  writeFileSync(entry, source);
  return entry;
}

/**
 * A sandbox session that confines nothing, so a test can assert on what heddle
 * decides rather than on what a backend enforces.
 *
 * Whether the plugin's process is confined is the only thing `remoteNodeDef`
 * consults, and a real backend would make these tests platform-dependent for no
 * extra claim. What a real one does to a cross-session path is asserted
 * elsewhere; what is asserted here is that heddle stops sending one.
 */
function stubSession(): SandboxSession {
  return {
    name: 'stub',
    workspace: scratch,
    wrap: (toolPath, args) => ({
      command: toolPath,
      args: args ?? [],
      env: { HEDDLE_SANDBOX: '1' },
    }),
    dispose: () => {},
  };
}

function manifest(
  componentType: string,
  capabilities: string[] = [],
  extra: Record<string, unknown> = {},
) {
  return {
    name: 'reporter-plugin',
    version: '1.0.0',
    capabilities,
    components: [{ componentType, ...extra }],
  };
}

/**
 * An operator who allows everything heddle serves.
 *
 * Deliberately not what these tests vary. A plugin still gets only what its own
 * manifest declares, so the capability cases change the manifest and leave the
 * policy alone — which is the half of the rule that a submitted plugin would
 * otherwise be able to probe for.
 */
const ALL: PluginCapability[] = ['runTool', 'emitEvent', 'log'];

/** start -> the plugin's node -> end. */
function flowUsing(componentType: string): string {
  return JSON.stringify({
    component_type: 'Flow',
    name: 'reporting-flow',
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
      p: { component_type: componentType, id: 'p', name: 'p' },
      e: { component_type: 'EndNode', id: 'e', name: 'e' },
    },
  });
}

interface Run {
  state: Record<string, unknown>;
  events: Event[];
}

/** Load a plugin, run the flow that uses it, and keep everything it emitted. */
async function run(
  componentType: string,
  entry: string,
  manifestData: unknown,
  flow: string = flowUsing(componentType),
  timeout = 5_000,
  session?: SandboxSession,
): Promise<Run> {
  const registry = PluginRegistry.empty();
  open.push(registry);
  registry.addRemote(
    loadRemotePlugin(manifestData, entry, { timeout, capabilities: ALL, session }),
  );

  // One collector on both handlers, because a plugin's events and the engine's
  // reach a client interleaved on one stream and several of these assert on
  // what a client would see. The compiled graph's handler is what a plugin
  // reports through; the runner's is what the engine reports through.
  const events: Event[] = [];
  const collect = (e: Event): void => {
    events.push(e);
  };

  const graph = compile(parseFlow(flow, registry), {
    plugins: registry,
    eventHandler: collect,
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

/** Every event a plugin put on the run's stream, engine events left out. */
function reported(events: Event[]): Event[] {
  return events.filter((e) => e.type.startsWith('plugin:') || e.type === 'plugin_log');
}

// ---------------------------------------------------------------------------
// emitEvent.
// ---------------------------------------------------------------------------

describe('a plugin emitting an event', () => {
  it('publishes it on the run stream, attributed and namespaced', async () => {
    const entry = writePlugin(
      'progress',
      `await callHost('emitEvent',
         { call: msg.id, name: 'step', data: { done: 3, total: 10 } });
       return { output: { ok: true } };`,
    );

    const { state, events } = await run(
      'ProgressNode',
      entry,
      manifest('ProgressNode', ['emitEvent']),
    );

    expect(state).toMatchObject({ ok: true });
    expect(reported(events)).toEqual([
      {
        // The plugin asked for "step" and got the rest from heddle. The
        // component type is in there because two plugins emitting "progress"
        // with different payloads would otherwise share one type and therefore
        // have no payload contract at all.
        type: 'plugin:ProgressNode:step',
        nodeName: 'p',
        nodeType: 'ProgressNode',
        data: { done: 3, total: 10 },
      },
    ]);
  });

  it('carries no data when the plugin sent none', async () => {
    const entry = writePlugin(
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

  it('cannot forge a builtin however it spells the name', async () => {
    // The attack the namespace exists to stop: a client that stops waiting on
    // `flow_complete` would be told the run was over by a node in the middle
    // of it. The plugin supplies only the last segment, so what it gets is an
    // event of its own with an unfortunate name.
    const entry = writePlugin(
      'forge',
      `for (const name of ['flow_complete', 'node_error', 'plugin_log']) {
         await callHost('emitEvent', { call: msg.id, name, data: { forged: true } });
       }
       return { output: {} };`,
    );

    const { events } = await run('ForgeNode', entry, manifest('ForgeNode', ['emitEvent']));

    expect(reported(events).map((e) => e.type)).toEqual([
      'plugin:ForgeNode:flow_complete',
      'plugin:ForgeNode:node_error',
      'plugin:ForgeNode:plugin_log',
    ]);
    // One flow_complete, and it is the engine's: the run really did finish
    // once. Counted rather than merely looked for, because a forged one would
    // pass a `some()` check by being indistinguishable.
    expect(events.filter((e) => e.type === 'flow_complete')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'node_error')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'plugin_log')).toHaveLength(0);
  });

  it('refuses a name that could carry a frame of its own', async () => {
    // The event type *is* the SSE event name, and that is the one part of a
    // frame written without JSON escaping. A newline in it ends the frame early
    // and everything after is read as a frame of the plugin's composition —
    // the forgery above, reached around the namespace instead of through it.
    const entry = writePlugin(
      'newline',
      `try { await callHost('emitEvent',
               { call: msg.id, name: 'ok\\nevent: flow_complete' });
             return { output: { err: 'none' } }; }
       catch (e) { return { output: { err: e.message } }; }`,
    );

    const { state, events } = await run(
      'NewlineNode',
      entry,
      manifest('NewlineNode', ['emitEvent']),
    );

    expect(String(state.err)).toMatch(/is not a usable event name/);
    expect(reported(events)).toEqual([]);
  });

  it('refuses an event that names no call', async () => {
    const entry = writePlugin(
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
    const entry = writePlugin(
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
    // The pending map holds heddle's `init` and `cancel` frames beside real
    // calls, and their ids are guessable: `init` is always 1. A plugin that
    // never answers it leaves that id alive for the whole process, so naming it
    // used to reach the "nothing built an executor here" branch — heddle
    // blaming its own wiring for a frame a plugin forged, and sending whoever
    // read it into plumbing that is working correctly.
    const entry = writeRawPlugin(
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
    // Never answered, which is what keeps heddle's pending id 1 alive.
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
    // The message this used to give, which points at heddle rather than at the
    // plugin that made it up.
    expect(String(state.err)).not.toMatch(/nowhere to report to/);
    expect(reported(events)).toEqual([]);
  });

  it('keeps the call alive for as long as it keeps reporting', async () => {
    // Nine hundred milliseconds of work under a three hundred millisecond
    // budget. The timeout is a silence budget, and a plugin reporting steadily
    // is the opposite of silent — without the reset, the natural way to say
    // "still working" is also what gets you killed for not working.
    const entry = writePlugin(
      'slow',
      `for (let i = 0; i < 9; i++) {
         await sleep(100);
         await callHost('emitEvent', { call: msg.id, name: 'tick', data: { i } });
       }
       return { output: { finished: true } };`,
    );

    const started = Date.now();
    const { state, events } = await run(
      'SlowNode',
      entry,
      manifest('SlowNode', ['emitEvent']),
      flowUsing('SlowNode'),
      300,
    );

    expect(state).toMatchObject({ finished: true });
    expect(reported(events)).toHaveLength(9);
    expect(Date.now() - started).toBeGreaterThan(300);
  });
});

// ---------------------------------------------------------------------------
// log.
// ---------------------------------------------------------------------------

describe('a plugin logging', () => {
  it('puts a line on the run stream, in heddle own shape', async () => {
    const entry = writePlugin(
      'noisy',
      `await callHost('log',
         { call: msg.id, level: 'warn', message: 'retrying after a 429' });
       return { output: {} };`,
    );

    const { events } = await run('NoisyNode', entry, manifest('NoisyNode', ['log']));

    // A level and a string, under heddle's own type — so a client can render
    // this without knowing the plugin exists, which is the whole difference
    // from an event's `data`.
    expect(reported(events)).toEqual([
      {
        type: 'plugin_log',
        nodeName: 'p',
        nodeType: 'NoisyNode',
        level: 'warn',
        message: 'retrying after a 429',
      },
    ]);
  });

  it('refuses a level heddle has no meaning for', async () => {
    const entry = writePlugin(
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
    const entry = writePlugin(
      'payload',
      `try { await callHost('log', { call: msg.id, level: 'info', message: { rows: 3 } });
             return { output: { err: 'none' } }; }
       catch (e) { return { output: { err: e.message } }; }`,
    );

    const { state } = await run('PayloadNode', entry, manifest('PayloadNode', ['log']));
    expect(String(state.err)).toMatch(/A structured payload belongs on emitEvent/);
  });
});

// ---------------------------------------------------------------------------
// Capabilities.
//
// Two independent yeses, as `runTool` already has: the manifest asks and the
// host grants. These vary the manifest, because a plugin that could learn the
// operator's policy by making a call and reading the error would be probing it.
// ---------------------------------------------------------------------------

describe('capabilities on the reporting verbs', () => {
  it('refuses an emitEvent the manifest never declared, naming the capability', async () => {
    const entry = writePlugin(
      'undeclared',
      `try { await callHost('emitEvent', { call: msg.id, name: 'step' });
             return { output: { err: 'none' } }; }
       catch (e) { return { output: { err: e.message } }; }`,
    );

    // The host grants everything and the reporter is wired. The one thing
    // missing is the declaration, so this asserts the declaration is what
    // carries the permission rather than documenting it.
    const { state, events } = await run('UndeclaredNode', entry, manifest('UndeclaredNode'));

    expect(String(state.err)).toMatch(/"emitEvent" is not granted to this plugin/);
    expect(String(state.err)).toMatch(/Add it to "capabilities" in the manifest/);
    // A gate that reported a denial after publishing would satisfy the message
    // assertion above and still have failed at its job.
    expect(reported(events)).toEqual([]);
  });

  it('refuses a log the manifest never declared', async () => {
    const entry = writePlugin(
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
    // Declaring one must not carry the other. They reach the same stream and
    // an operator who allowed structured events has not thereby allowed a
    // plugin to write prose into somebody's console.
    const entry = writePlugin(
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
    const entry = writePlugin('ungranted', `return { output: {} };`);
    expect(() =>
      loadRemotePlugin(manifest('UngrantedNode', ['emitEvent']), entry, {
        capabilities: ['runTool'],
      }),
    ).toThrow(/requests "emitEvent", which this host does not grant/);
  });

  it('lists the reporting verbs among what heddle serves', () => {
    // A misspelt capability is caught next to the plugin that wrote it, and the
    // error has to name what does exist — that is the only way an author tells
    // a typo from a heddle too old to have the verb.
    const entry = writePlugin('bogus', `return { output: {} };`);
    expect(() =>
      loadRemotePlugin(manifest('BogusNode', ['emitEvents']), entry, { capabilities: ALL }),
    ).toThrow(/It serves: runTool, emitEvent, log/);
  });
});

// ---------------------------------------------------------------------------
// The workspace.
// ---------------------------------------------------------------------------

describe('the workspace a node is given', () => {
  it('arrives with the request and is writable', async () => {
    const entry = writePlugin(
      'writer',
      `const { writeFileSync } = await import('node:fs');
       writeFileSync(msg.params.workspace + '/note.txt', 'hello');
       return { output: { dir: msg.params.workspace } };`,
    );

    const { state } = await run('WriterNode', entry, manifest('WriterNode'));

    expect(typeof state.dir).toBe('string');
    // Gone by the time the run ended. The directory is scoped to one execution
    // — a plugin that fails partway leaves nothing, and a loop revisiting the
    // node gets a fresh one rather than a path that has already been removed.
    expect(existsSync(state.dir as string)).toBe(false);
  });

  it('needs no capability, because it is not a call into heddle', async () => {
    // A manifest declaring nothing at all. The path is in `ExecuteParams`, so
    // there is no verb to gate and `PluginCapability` stays exactly the set of
    // reverse calls rather than a set of reverse calls plus one field.
    const entry = writePlugin(
      'nogrant',
      `return { output: { got: typeof msg.params.workspace } };`,
    );
    const { state } = await run('NoGrantNode', entry, manifest('NoGrantNode'));
    expect(state.got).toBe('string');
  });

  it('is withheld when the plugin process is confined to a sandbox of its own', async () => {
    // The live case under `heddle serve --safe`: `server/plugins.ts` gives every
    // submitted plugin its own session, and the node's tool scope is a
    // different one. The path heddle used to send was a real absolute path the
    // plugin could not open — ENOENT under bubblewrap, EPERM under seatbelt —
    // and the failure surfaced as the plugin's own filesystem error, naming
    // nothing that would lead anyone here. It is also a host path from outside
    // the plugin's confinement, handed unconditionally to an untrusted process.
    const entry = writePlugin(
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
    // Marked rather than merely absent: a transform is also sent no workspace,
    // and the two need different things said to different people.
    expect(state.why).toBe('confined');
  });

  it('fails getWorkspace naming the sandbox, not transforms', async () => {
    // What an author actually reads. Before the marker existed the only
    // message `workspaceOf` had was about transforms owning no tool scope,
    // which would send a node author to change a component that is correct.
    const entry = writeHelperPlugin(
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

// ---------------------------------------------------------------------------
// Transforms.
//
// A transform is not a node, so the attribution question has a different answer
// and this is where it is pinned. The flow needs no model credential: a `pre`
// transform that rejects makes heddle skip the model call entirely.
// ---------------------------------------------------------------------------

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
        // Distinct from the agent's own name below, so the assertion on
        // `nodeName` says which of the two a transform's events are filed
        // under rather than passing whichever it is.
        name: 'agent_node',
        agent: {
          component_type: 'Agent',
          id: 'ia',
          name: 'the_agent',
          system_prompt: 'be helpful',
          // Unreachable on purpose: the transform rejects, so this is never
          // dialled, and a test that started passing for the wrong reason
          // would fail loudly instead.
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

describe('a transform reporting', () => {
  it('files its events under the agent it hangs off', async () => {
    const entry = writePlugin(
      'guard',
      `await callHost('emitEvent',
         { call: msg.id, name: 'checked', data: { rule: 'blocklist' } });
       await callHost('log', { call: msg.id, level: 'info', message: 'blocked' });
       return { action: 'reject', reason: 'blocked' };`,
    );

    const { events } = await run(
      'Blocklist',
      entry,
      transformManifest('Blocklist', ['emitEvent', 'log']),
      agentFlowWithTransform('Blocklist'),
    );

    // A transform holds no position in the graph, so the agent is the only
    // thing a consumer can hang its events off — the `Agent`'s own name, which
    // is what the chain is built with. Which transform spoke is in `nodeType`,
    // and in the event type itself.
    expect(reported(events)).toEqual([
      {
        type: 'plugin:Blocklist:checked',
        nodeName: 'the_agent',
        nodeType: 'Blocklist',
        data: { rule: 'blocklist' },
      },
      {
        type: 'plugin_log',
        nodeName: 'the_agent',
        nodeType: 'Blocklist',
        level: 'info',
        message: 'blocked',
      },
    ]);
  });

  it('is sent no workspace, because it owns no tool scope', async () => {
    const entry = writePlugin(
      'nodir',
      `return { action: 'reject', reason: 'workspace=' + typeof msg.params.workspace };`,
    );

    const { state } = await run(
      'NoDir',
      entry,
      transformManifest('NoDir'),
      agentFlowWithTransform('NoDir'),
    );

    expect(state.transform_reason).toBe('workspace=undefined');
  });
});

// ---------------------------------------------------------------------------
// The inlined runtime helper.
//
// Everything above is what heddle enforces. This is what the helper does on top
// of it, and the reason it does anything at all: `emitEvent` and `log` return
// nothing, so heddle's refusal comes back on a frame nobody is awaiting. A
// plugin using the helper gets its mistakes thrown at the call that made them,
// which is what an in-process plugin gets for the same mistake.
// ---------------------------------------------------------------------------

describe('the inlined runtime helper', () => {
  it('reports through ctx, without the author naming a call', async () => {
    const entry = writeHelperPlugin(
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
    const entry = writeHelperPlugin(
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

  it('throws at the call when the payload is not JSON', async () => {
    // The one check heddle cannot make for a remote plugin: whatever reaches
    // the host arrived as JSON and therefore re-serializes. Caught here it is
    // still the plugin's own call failing, and the message still names the
    // event.
    const entry = writeHelperPlugin(
      'helper-cycle',
      `serve({
         Cyclic: {
           execute: (input, ctx) => {
             const loop = {}; loop.self = loop;
             try { ctx.emitEvent('step', loop); return { output: { err: 'none' } }; }
             catch (e) { return { output: { err: e.message } }; }
           },
         },
       });`,
    );

    const { state, events } = await run('Cyclic', entry, manifest('Cyclic', ['emitEvent']));
    expect(String(state.err)).toMatch(/"step" was emitted with data that is not JSON/);
    expect(reported(events)).toEqual([]);
  });

  it('throws at the call when the capability was never declared', async () => {
    // Read off the grant `init` delivered, so the helper refuses exactly what
    // the host would have refused — and refuses it where a plugin author can
    // see it, rather than on a response frame the author never awaits.
    const entry = writeHelperPlugin(
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
    const entry = writeHelperPlugin(
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
    const entry = writeHelperPlugin(
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
