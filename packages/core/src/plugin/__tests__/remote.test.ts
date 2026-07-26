/**
 * Out-of-process plugins.
 *
 * The isolation block at the bottom is the reason this whole path exists: it
 * re-runs the attack that succeeds against the in-process API, and asserts it
 * now fails. If those tests ever go green for the wrong reason — a plugin that
 * silently did not run, say — the rest of the file is what catches it.
 *
 * Test plugins here hand-roll the protocol in plain JS rather than importing
 * the `serve()` helper. That is deliberate: it keeps the tests independent of
 * the helper, and demonstrates the protocol is small enough to implement in a
 * few lines, which is the bar a non-JavaScript plugin has to clear.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRemotePlugin } from '../remote-loader.js';
import { PluginRegistry } from '../registry.js';
import { compile } from '../../graph/compile.js';
import { validate } from '../../graph/validate.js';
import { parseFlow } from '../../spec/parser.js';
import { Runner } from '../../runner/runner.js';
import { DEFAULT_RUNNER_OPTIONS } from '../../runner/options.js';
import { PluginError } from '../../errors.js';

let scratch: string;
const open: PluginRegistry[] = [];

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'heddle-remote-plugin-'));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

afterEach(() => {
  // A leaked plugin process would keep vitest from exiting, and would also
  // invalidate the isolation tests below.
  while (open.length) open.pop()!.dispose();
});

/** The protocol, in as little JS as it can be written. */
const PREAMBLE = `
let buf = '';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const pendingTools = new Map();
let toolId = 0;
const runTool = (name, input) => new Promise((res, rej) => {
  const id = 't' + toolId++;
  pendingTools.set(id, { res, rej });
  send({ id, method: 'runTool', params: { name, input } });
});
process.stdin.setEncoding('utf-8');
process.stdin.on('data', async (chunk) => {
  buf += chunk;
  const lines = buf.split('\\n');
  buf = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (!msg.method) {
      const p = pendingTools.get(String(msg.id));
      if (p) { pendingTools.delete(String(msg.id));
        msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result); }
      continue;
    }
    try { send({ id: msg.id, result: await handle(msg) }); }
    catch (e) { send({ id: msg.id, error: { message: String(e && e.message || e) } }); }
  }
});
`;

function writePlugin(name: string, handleBody: string): string {
  const dir = join(scratch, name);
  rmSync(dir, { recursive: true, force: true });
  const entry = join(scratch, `${name}.mjs`);
  writeFileSync(entry, `${PREAMBLE}\nasync function handle(msg) {\n${handleBody}\n}\n`);
  return entry;
}

function manifest(componentType: string, extra: Record<string, unknown> = {}) {
  return {
    name: 'test-plugin',
    version: '1.0.0',
    components: [{ componentType, ...extra }],
  };
}

/** A flow: start -> the plugin's node -> end. */
function flowUsing(componentType: string): string {
  return JSON.stringify({
    component_type: 'Flow',
    name: 'remote-flow',
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

/** Load a plugin, compile the flow that uses it, and run it. */
async function runWith(
  componentType: string,
  entry: string,
  manifestData: unknown,
  inputs: Record<string, unknown> = { text: 'hello' },
  deps: Record<string, unknown> = {},
  timeout = 5000,
): Promise<Record<string, unknown>> {
  const registry = PluginRegistry.empty();
  open.push(registry);
  registry.addRemote(loadRemotePlugin(manifestData, entry, { timeout }));

  const pf = parseFlow(flowUsing(componentType), registry);
  const graph = compile(pf, { plugins: registry, ...deps });
  validate(graph);

  const runner = new Runner(graph, { ...DEFAULT_RUNNER_OPTIONS, verbose: false });
  const state = await runner.run(undefined, inputs);
  return state.toData() as Record<string, unknown>;
}

describe('running a node in another process', () => {
  it('executes and returns its output', async () => {
    const entry = writePlugin(
      'shout',
      `return { output: { shouted: String(msg.params.input.text).toUpperCase() } };`,
    );
    const state = await runWith('ShoutNode', entry, manifest('ShoutNode'));
    expect(state.shouted).toBe('HELLO');
  });

  it('passes the node its own spec fields', async () => {
    const entry = writePlugin('conf', `return { output: { got: msg.params.node.name } };`);
    const state = await runWith('ConfNode', entry, manifest('ConfNode'));
    expect(state.got).toBe('p');
  });

  it('surfaces an error thrown inside the plugin', async () => {
    const entry = writePlugin('boom', `throw new Error('deliberate failure');`);
    await expect(runWith('BoomNode', entry, manifest('BoomNode'))).rejects.toThrow(
      /deliberate failure/,
    );
  });

  it('rejects a result that is not { output }', async () => {
    const entry = writePlugin('bad', `return { nope: true };`);
    await expect(runWith('BadNode', entry, manifest('BadNode'))).rejects.toThrow(
      /no "output" object/,
    );
  });

  it('names the likely cause when a plugin writes to stdout', async () => {
    const entry = writePlugin(
      'chatty',
      `process.stdout.write('debug noise\\n'); return { output: {} };`,
    );
    await expect(runWith('ChattyNode', entry, manifest('ChattyNode'))).rejects.toThrow(
      /Logs belong on stderr/,
    );
  });

  it('times out a plugin that never answers', async () => {
    const entry = writePlugin('hang', `return new Promise(() => {});`);
    // Well under vitest's own 5s ceiling, so this asserts the host's timeout
    // rather than racing it.
    await expect(
      runWith('HangNode', entry, manifest('HangNode'), {}, {}, 300),
    ).rejects.toThrow(/did not answer execute within/);
  });
});

describe('reverse calls', () => {
  it('runs a tool on the plugin behalf', async () => {
    const entry = writePlugin(
      'usetool',
      `const r = await runTool('echo', { v: msg.params.input.text });
       return { output: { fromTool: r.echoed } };`,
    );

    const state = await runWith('ToolNode2', entry, manifest('ToolNode2'), { text: 'ping' }, {
      toolRegistry: {
        lookup: (name: string) =>
          name === 'echo' ? { name, description: '', path: '/echo' } : undefined,
        all: () => [],
      },
      toolExecutor: {
        execute: async (_s: unknown, _p: string, input: Record<string, unknown>) => ({
          output: { echoed: `tool saw ${input.v}` },
          stderr: '',
        }),
      },
    });

    expect(state.fromTool).toBe('tool saw ping');
  });

  it('reports a tool the registry does not have', async () => {
    const entry = writePlugin(
      'missingtool',
      `try { await runTool('absent', {}); return { output: { ok: true } }; }
       catch (e) { return { output: { err: e.message } }; }`,
    );

    const state = await runWith('MissingToolNode', entry, manifest('MissingToolNode'), {}, {
      toolRegistry: { lookup: () => undefined, all: () => [] },
      toolExecutor: { execute: async () => ({ output: {}, stderr: '' }) },
    });

    expect(String(state.err)).toMatch(/tool "absent" not found/);
  });
});

describe('the manifest is data, not code', () => {
  it('supplies inputs, outputs and branches without starting the process', async () => {
    const entry = writePlugin('declared', `return { output: {}, branch: 'left' };`);
    const registry = PluginRegistry.empty();
    open.push(registry);
    registry.addRemote(
      loadRemotePlugin(
        manifest('DeclaredNode', {
          inputs: [{ title: 'text', type: 'string' }],
          outputs: [{ title: 'result', type: 'string' }],
          branches: ['left', 'right'],
        }),
        entry,
      ),
    );

    // Parsing alone must fill these in. If it needed the process, this would
    // hang or throw rather than resolve synchronously.
    const pf = parseFlow(flowUsing('DeclaredNode'), registry);
    const node = pf.parsedNodes.find((n) => n.name === 'p') as unknown as {
      branches: string[];
      inputs: unknown[];
    };
    expect(node.branches).toEqual(['left', 'right']);
    expect(node.inputs).toHaveLength(1);
  });

  it('validates a component against the manifest schema', async () => {
    const entry = writePlugin('schema', `return { output: {} };`);
    const registry = PluginRegistry.empty();
    open.push(registry);
    registry.addRemote(
      loadRemotePlugin(
        manifest('StrictNode', {
          schema: { type: 'object', required: ['threshold'] },
        }),
        entry,
      ),
    );

    expect(() => parseFlow(flowUsing('StrictNode'), registry)).toThrow(/"threshold" is required/);
  });

  it('refuses a manifest with no components', () => {
    const entry = writePlugin('empty', `return { output: {} };`);
    expect(() =>
      loadRemotePlugin({ name: 'x', version: '1', components: [] }, entry),
    ).toThrow(PluginError);
  });

  it('refuses a component type that would shadow a builtin', () => {
    const entry = writePlugin('shadow', `return { output: {} };`);
    const registry = PluginRegistry.empty();
    open.push(registry);
    expect(() =>
      registry.addRemote(loadRemotePlugin(manifest('AgentNode'), entry)),
    ).toThrow(/builtin Agent Spec type/);
  });
});

// ---------------------------------------------------------------------------
// The point of the exercise.
// ---------------------------------------------------------------------------

describe('isolation', () => {
  it('does not hand the plugin the server environment', async () => {
    process.env.HEDDLE_TEST_SECRET = 'super-secret-value';
    try {
      const entry = writePlugin(
        'env',
        `return { output: { secret: process.env.HEDDLE_TEST_SECRET ?? null,
                            keys: Object.keys(process.env) } };`,
      );
      const state = await runWith('EnvNode', entry, manifest('EnvNode'));

      // In-process this reads process.env — every key the server holds,
      // including whatever credential it was started with.
      expect(state.secret).toBeNull();

      // Not an emptiness check: macOS injects __CF_USER_TEXT_ENCODING into
      // every process regardless of the environment passed to spawn, so it is
      // present on both sides without having crossed. The property that matters
      // is that nothing else of the parent's did.
      const injectedByOs = new Set(['__CF_USER_TEXT_ENCODING']);
      const leaked = (state.keys as string[]).filter(
        (key) => !injectedByOs.has(key) && key in process.env,
      );
      expect(leaked).toEqual([]);
    } finally {
      delete process.env.HEDDLE_TEST_SECRET;
    }
  });

  it('does not carry state from one run into the next', async () => {
    // Exactly the attack that works against the in-process API: plant
    // something on a global in one run, read it back in another.
    const entry = writePlugin(
      'planter',
      `globalThis.__planted ??= [];
       if (msg.params.input.plant) globalThis.__planted.push(msg.params.input.plant);
       return { output: { seen: globalThis.__planted.slice() } };`,
    );
    const m = manifest('PlanterNode');

    const first = await runWith('PlanterNode', entry, m, { plant: 'run-one-secret' });
    expect(first.seen).toEqual(['run-one-secret']);

    const second = await runWith('PlanterNode', entry, m, {});
    // A shared process would return ['run-one-secret'] here.
    expect(second.seen).toEqual([]);
  });

  it('keeps two concurrent runs from seeing each other', async () => {
    const entry = writePlugin(
      'concurrent',
      `globalThis.__seen ??= [];
       globalThis.__seen.push(msg.params.input.text);
       return { output: { seen: globalThis.__seen.slice() } };`,
    );
    const m = manifest('ConcurrentNode');

    const [a, b] = await Promise.all([
      runWith('ConcurrentNode', entry, m, { text: 'alice-private' }),
      runWith('ConcurrentNode', entry, m, { text: 'bob-private' }),
    ]);

    expect(a.seen).toEqual(['alice-private']);
    expect(b.seen).toEqual(['bob-private']);
  });

  it('contains a plugin that kills its own process', async () => {
    const entry = writePlugin('suicide', `process.exit(1);`);
    await expect(runWith('SuicideNode', entry, manifest('SuicideNode'))).rejects.toThrow(
      /exited/,
    );
    // The test process is still here to assert it, which is the other half of
    // the claim: the plugin's failure did not become the server's.
    expect(process.pid).toBeGreaterThan(0);
  });

  it('stops the plugin process when the registry is disposed', async () => {
    const entry = writePlugin('lives', `return { output: {} };`);
    const registry = PluginRegistry.empty();
    const remote = loadRemotePlugin(manifest('LivesNode'), entry, { timeout: 5000 });
    registry.addRemote(remote);

    await remote.host.call('execute', {
      componentType: 'LivesNode',
      node: {},
      input: {},
    });

    registry.dispose();

    await expect(
      remote.host.call('execute', { componentType: 'LivesNode', node: {}, input: {} }),
    ).rejects.toThrow(/disposed/);
  });
});
