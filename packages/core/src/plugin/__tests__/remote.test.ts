import { describe, it, expect } from 'vitest';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { PluginError } from '../../errors.js';
import {
  ALL_CAPABILITIES,
  flowUsing,
  manifest,
  useDisposal,
  useScratch,
} from './helpers/remote-plugin.js';

const scratch = useScratch('heddle-remote-plugin-');
const open = useDisposal<PluginRegistry>();

async function runFlow(
  flow: string,
  entry: string,
  manifestData: unknown,
  inputs: Record<string, unknown>,
  deps: Record<string, unknown>,
  timeout: number,
  events?: Event[],
): Promise<Record<string, unknown>> {
  const registry = PluginRegistry.empty();
  open.track(registry);
  registry.addRemote(
    loadRemotePlugin(manifestData, entry, { timeout, capabilities: [...ALL_CAPABILITIES] }),
  );

  const pf = parseFlow(flow, registry);
  const graph = compile(pf, {
    plugins: registry,
    scratchWorkspace: createScratchWorkspace,
    ...deps,
  });
  validate(graph);

  const runner = new Runner(graph, {
    ...DEFAULT_RUNNER_OPTIONS,
    verbose: false,
    eventHandler: events ? (e) => events.push(e) : undefined,
  });
  const state = await runner.run(undefined, inputs);
  return state.toData() as Record<string, unknown>;
}

async function runWith(
  componentType: string,
  entry: string,
  manifestData: unknown,
  inputs: Record<string, unknown> = { text: 'hello' },
  deps: Record<string, unknown> = {},
  timeout = 5000,
): Promise<Record<string, unknown>> {
  return runFlow(flowUsing(componentType), entry, manifestData, inputs, deps, timeout);
}

describe('running a node in another process', () => {
  it('executes and returns its output', async () => {
    const entry = scratch.writePlugin(
      'shout',
      `return { output: { shouted: String(msg.params.input.text).toUpperCase() } };`,
    );
    const state = await runWith('ShoutNode', entry, manifest('ShoutNode'));
    expect(state.shouted).toBe('HELLO');
  });

  it('passes the node its own spec fields', async () => {
    const entry = scratch.writePlugin('conf', `return { output: { got: msg.params.node.name } };`);
    const state = await runWith('ConfNode', entry, manifest('ConfNode'));
    expect(state.got).toBe('p');
  });

  it('surfaces an error thrown inside the plugin', async () => {
    const entry = scratch.writePlugin('boom', `throw new Error('deliberate failure');`);
    await expect(runWith('BoomNode', entry, manifest('BoomNode'))).rejects.toThrow(
      /deliberate failure/,
    );
  });

  it('rejects a result that is not { output }', async () => {
    const entry = scratch.writePlugin('bad', `return { nope: true };`);
    await expect(runWith('BadNode', entry, manifest('BadNode'))).rejects.toThrow(
      /no "output" object/,
    );
  });

  it('names the likely cause when a plugin writes to stdout', async () => {
    const entry = scratch.writePlugin(
      'chatty',
      `process.stdout.write('debug noise\\n'); return { output: {} };`,
    );
    await expect(runWith('ChattyNode', entry, manifest('ChattyNode'))).rejects.toThrow(
      /Logs belong on stderr/,
    );
  });

  it('times out a plugin that never answers', async () => {
    const entry = scratch.writePlugin('hang', `return new Promise(() => {});`);
    await expect(
      runWith('HangNode', entry, manifest('HangNode'), {}, {}, 300),
    ).rejects.toThrow(/did not answer execute within/);
  });
});

function branchingFlowUsing(componentType: string): string {
  const edge = (name: string, to: string, branch: string | null) => ({
    component_type: 'ControlFlowEdge',
    name,
    from_node: { $component_ref: 'p' },
    from_branch: branch,
    to_node: { $component_ref: to },
  });

  return JSON.stringify({
    component_type: 'Flow',
    name: 'branching-flow',
    start_node: { $component_ref: 's' },
    nodes: [
      { $component_ref: 's' },
      { $component_ref: 'p' },
      { $component_ref: 'el' },
      { $component_ref: 'er' },
      { $component_ref: 'ed' },
    ],
    control_flow_connections: [
      {
        component_type: 'ControlFlowEdge',
        name: 'enter',
        from_node: { $component_ref: 's' },
        to_node: { $component_ref: 'p' },
      },
      edge('to_left', 'el', 'left'),
      edge('to_right', 'er', 'right'),
      edge('to_default', 'ed', null),
    ],
    $referenced_components: {
      s: {
        component_type: 'StartNode',
        id: 's',
        name: 's',
        outputs: [{ title: 'pick', type: 'string' }],
      },
      p: { component_type: componentType, id: 'p', name: 'p' },
      el: { component_type: 'EndNode', id: 'el', name: 'end_left' },
      er: { component_type: 'EndNode', id: 'er', name: 'end_right' },
      ed: { component_type: 'EndNode', id: 'ed', name: 'end_default' },
    },
  });
}

function endReached(events: Event[]): string | undefined {
  return events
    .filter((e) => e.type === 'node_complete' && e.nodeType === 'EndNode')
    .at(-1)?.nodeName;
}

describe('branching out of a plugin node', () => {
  const CHOOSER = `return { output: { chose: msg.params.input.pick },
                           branch: msg.params.input.pick };`;

  async function route(
    entry: string,
    manifestData: unknown,
    pick: string,
  ): Promise<{ end: string | undefined; state: Record<string, unknown> }> {
    const events: Event[] = [];
    const state = await runFlow(
      branchingFlowUsing('ChooserNode'),
      entry,
      manifestData,
      { pick },
      {},
      5000,
      events,
    );
    return { end: endReached(events), state };
  }

  it('routes on the branch the plugin returned', async () => {
    const entry = scratch.writePlugin('chooser', CHOOSER);
    const declared = manifest('ChooserNode', { branches: ['left', 'right'] });

    expect(await route(entry, declared, 'left')).toMatchObject({ end: 'end_left' });
    expect(await route(entry, declared, 'right')).toMatchObject({ end: 'end_right' });
  });

  it('takes the unbranched edge when the plugin names no branch', async () => {
    const entry = scratch.writePlugin('nobranch', `return { output: { ran: true } };`);
    const { end, state } = await route(
      entry,
      manifest('ChooserNode', { branches: ['left', 'right'] }),
      'left',
    );

    expect(end).toBe('end_default');
    expect(state).toMatchObject({ ran: true });
  });

  it('refuses a branch the manifest did not declare', async () => {
    const entry = scratch.writePlugin('undeclaredbranch', CHOOSER);
    // The manifest declares both branches the flow's edges leave on, so the
    // undeclared one has to come from the plugin at run time. Declaring fewer
    // than the flow routes on is caught by `validate` before anything runs,
    // which is a different check answering a different question.
    await expect(
      route(
        entry,
        manifest('ChooserNode', { branches: ['left', 'right'] }),
        'sideways',
      ),
    ).rejects.toThrow(
      /returned branch "sideways", which is not in its declared branches \[left, right\]/,
    );
  });

  it('refuses any branch from a node that declared none', async () => {
    const entry = scratch.writePlugin('silentbranch', CHOOSER);
    await expect(route(entry, manifest('ChooserNode'), 'left')).rejects.toThrow(
      /not in its declared branches \[\]/,
    );
  });

  it('refuses a branch that is not a string', async () => {
    const entry = scratch.writePlugin('numericbranch', `return { output: {}, branch: 42 };`);
    await expect(
      route(
        entry,
        manifest('ChooserNode', { branches: ['left', 'right'] }),
        'left',
      ),
    ).rejects.toThrow(/returned a non-string "branch"/);
  });
});

describe('reverse calls', () => {
  it('runs a tool on the plugin behalf', async () => {
    const entry = scratch.writePlugin(
      'usetool',
      `const r = await runTool('echo', { v: msg.params.input.text });
       return { output: { fromTool: r.echoed } };`,
    );

    const state = await runWith('ToolNode2', entry, manifest('ToolNode2', {}, ['runTool']), { text: 'ping' }, {
      toolRegistry: {
        lookup: (name: string) =>
          name === 'echo' ? { name, description: '', impl: { kind: 'path' as const, path: '/echo' } } : undefined,
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
    const entry = scratch.writePlugin(
      'missingtool',
      `try { await runTool('absent', {}); return { output: { ok: true } }; }
       catch (e) { return { output: { err: e.message } }; }`,
    );

    const state = await runWith('MissingToolNode', entry, manifest('MissingToolNode', {}, ['runTool']), {}, {
      toolRegistry: { lookup: () => undefined, all: () => [] },
      toolExecutor: { execute: async () => ({ output: {}, stderr: '' }) },
    });

    expect(String(state.err)).toMatch(/tool "absent" not found/);
  });

  it('names what it does serve when the plugin calls something else', async () => {
    const entry = scratch.writePlugin(
      'wrongverb',
      `try { await callHost('getState', { key: 'x' }); return { output: { err: 'none' } }; }
       catch (e) { return { output: { err: e.message } }; }`,
    );

    const state = await runWith('WrongVerbNode', entry, manifest('WrongVerbNode'));
    expect(String(state.err)).toMatch(/does not serve "getState"/);
    expect(String(state.err)).toMatch(/It serves: runTool/);
  });

  it('refuses a runTool that names no tool', async () => {
    const entry = scratch.writePlugin(
      'noname',
      `try { await callHost('runTool', { input: {} }); return { output: { err: 'none' } }; }
       catch (e) { return { output: { err: e.message } }; }`,
    );

    const state = await runWith('NoNameNode', entry, manifest('NoNameNode', {}, ['runTool']), {}, {
      toolRegistry: { lookup: () => undefined, all: () => [] },
      toolExecutor: { execute: async () => ({ output: {}, stderr: '' }) },
    });

    expect(String(state.err)).toMatch(/runTool needs a "name"/);
  });
});

function scopedExecutor(): {
  execute: (
    signal: AbortSignal | undefined,
    path: string,
    input: Record<string, unknown>,
  ) => Promise<{ output: Record<string, unknown>; stderr: string }>;
  beginScope: (label: string) => {
    executor: unknown;
    workspace: string;
    dispose: () => void;
  };
} {
  let scopes = 0;
  const at = (workspace: string): ReturnType<typeof scopedExecutor> => ({
    execute: async (signal) => ({
      output: { workspace, sawSignal: signal !== undefined },
      stderr: '',
    }),
    beginScope: (label: string) => {
      const scope = `/scope-${label}-${++scopes}`;
      return { executor: at(scope), workspace: scope, dispose: () => {} };
    },
  });
  return at('/unscoped');
}

describe('where a plugin node tools run', () => {
  it('runs them in the scope heddle opened for that execution', async () => {
    const entry = scratch.writeHelperPlugin(
      'scoped-tool',
      `serve({
         ScopedToolNode: {
           async execute(input, ctx) {
             const r = await ctx.runTool('where', {});
             return { output: { toolSaw: r.workspace, pluginSaw: ctx.getWorkspace() } };
           },
         },
       });`,
    );

    const state = await runWith(
      'ScopedToolNode',
      entry,
      manifest('ScopedToolNode', {}, ['runTool']),
      {},
      {
        toolRegistry: {
          lookup: (name: string) => ({ name, description: '', impl: { kind: 'path' as const, path: '/where' } }),
          all: () => [],
        },
        toolExecutor: scopedExecutor(),
      },
    );

    expect(state.pluginSaw).toBe('/scope-p-1');
    expect(state.toolSaw).toBe(state.pluginSaw);
  });

  it('gives the tool the run signal, which the host-wide runner drops', async () => {
    const entry = scratch.writeHelperPlugin(
      'signalled-tool',
      `serve({
         SignalledToolNode: {
           async execute(input, ctx) {
             const r = await ctx.runTool('where', {});
             return { output: { sawSignal: r.sawSignal } };
           },
         },
       });`,
    );

    const state = await runWith(
      'SignalledToolNode',
      entry,
      manifest('SignalledToolNode', {}, ['runTool']),
      {},
      {
        toolRegistry: {
          lookup: (name: string) => ({ name, description: '', impl: { kind: 'path' as const, path: '/where' } }),
          all: () => [],
        },
        toolExecutor: scopedExecutor(),
      },
    );

    expect(state.sawSignal).toBe(true);
  });

  it('still serves a plugin that hand-rolls the protocol and names no call', async () => {
    const entry = scratch.writePlugin(
      'callless-tool',
      `const r = await runTool('where', {});
       return { output: { toolSaw: r.workspace } };`,
    );

    const state = await runWith(
      'CalllessToolNode',
      entry,
      manifest('CalllessToolNode', {}, ['runTool']),
      {},
      {
        toolRegistry: {
          lookup: (name: string) => ({ name, description: '', impl: { kind: 'path' as const, path: '/where' } }),
          all: () => [],
        },
        toolExecutor: scopedExecutor(),
      },
    );

    expect(state.toolSaw).toBe('/unscoped');
  });
});

describe('capabilities', () => {
  it('refuses a runTool the manifest never declared', async () => {
    const entry = scratch.writePlugin(
      'undeclared',
      `try { await runTool('echo', {}); return { output: { err: 'none' } }; }
       catch (e) { return { output: { err: e.message } }; }`,
    );

    let toolRuns = 0;
    const state = await runWith('UndeclaredNode', entry, manifest('UndeclaredNode'), {}, {
      toolRegistry: {
        lookup: (name: string) => ({ name, description: '', impl: { kind: 'path' as const, path: '/echo' } }),
        all: () => [],
      },
      toolExecutor: {
        execute: async () => {
          toolRuns += 1;
          return { output: {}, stderr: '' };
        },
      },
    });

    expect(String(state.err)).toMatch(/"runTool" is not granted to this plugin/);
    expect(String(state.err)).toMatch(/Add it to "capabilities" in the manifest/);
    expect(toolRuns).toBe(0);
  });

  it('lets a plugin that declared it through', async () => {
    const entry = scratch.writePlugin(
      'declaredtool',
      `const r = await runTool('echo', {}); return { output: { got: r.echoed } };`,
    );

    const state = await runWith(
      'DeclaredToolNode',
      entry,
      manifest('DeclaredToolNode', {}, ['runTool']),
      {},
      {
        toolRegistry: {
          lookup: (name: string) => ({ name, description: '', impl: { kind: 'path' as const, path: '/echo' } }),
          all: () => [],
        },
        toolExecutor: { execute: async () => ({ output: { echoed: 'ran' }, stderr: '' }) },
      },
    );

    expect(state).toMatchObject({ got: 'ran' });
  });

  it('refuses at load a capability the host does not grant', () => {
    const entry = scratch.writePlugin('ungranted', `return { output: {} };`);
    expect(() =>
      loadRemotePlugin(manifest('UngrantedNode', {}, ['runTool']), entry, {
        capabilities: [],
      }),
    ).toThrow(/requests "runTool", which this host does not grant/);
  });

  it('names what the host does grant when it refuses', () => {
    const entry = scratch.writePlugin('ungranted2', `return { output: {} };`);
    expect(() =>
      loadRemotePlugin(manifest('Ungranted2Node', {}, ['runTool']), entry),
    ).toThrow(/Granted here: nothing/);
  });

  it('refuses a capability heddle does not serve, before any grant is consulted', () => {
    const entry = scratch.writePlugin('bogus', `return { output: {} };`);
    expect(() =>
      loadRemotePlugin(manifest('BogusNode', {}, ['readTheDisk']), entry, {
        capabilities: [...ALL_CAPABILITIES],
      }),
    ).toThrow(/requests capability "readTheDisk", which heddle does not serve/);
  });

  it('loads a manifest that says nothing about capabilities', async () => {
    const entry = scratch.writePlugin('silent', `return { output: { ran: true } };`);
    const state = await runWith('SilentNode', entry, manifest('SilentNode'));
    expect(state).toMatchObject({ ran: true });
  });

  it('distinguishes a missing tool runner from a missing grant', async () => {
    const entry = scratch.writePlugin(
      'norunner',
      `try { await runTool('echo', {}); return { output: { err: 'none' } }; }
       catch (e) { return { output: { err: e.message } }; }`,
    );

    const registry = PluginRegistry.empty();
    open.track(registry);
    const remote = loadRemotePlugin(manifest('NoRunnerNode', {}, ['runTool']), entry, {
      timeout: 5000,
      capabilities: [...ALL_CAPABILITIES],
    });
    registry.addRemote(remote);

    const result = (await remote.host.call('execute', {
      componentType: 'NoRunnerNode',
      node: {},
      input: {},
      workspace: scratch.path,
    })) as { output: Record<string, unknown> };

    expect(String(result.output.err)).toMatch(/no tool runner was installed/);
    expect(String(result.output.err)).not.toMatch(/capabilities/);
  });
});

describe('the manifest is data, not code', () => {
  it('supplies inputs, outputs and branches without starting the process', async () => {
    const entry = scratch.writePlugin('declared', `return { output: {}, branch: 'left' };`);
    const registry = PluginRegistry.empty();
    open.track(registry);
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

    const pf = parseFlow(flowUsing('DeclaredNode'), registry);
    const node = pf.parsedNodes.find((n) => n.name === 'p') as unknown as {
      branches: string[];
      inputs: unknown[];
    };
    expect(node.branches).toEqual(['left', 'right']);
    expect(node.inputs).toHaveLength(1);
  });

  it('validates a component against the manifest schema', async () => {
    const entry = scratch.writePlugin('schema', `return { output: {} };`);
    const registry = PluginRegistry.empty();
    open.track(registry);
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
    const entry = scratch.writePlugin('empty', `return { output: {} };`);
    expect(() =>
      loadRemotePlugin({ name: 'x', version: '1', components: [] }, entry),
    ).toThrow(PluginError);
  });

  it('refuses a component type that would shadow a builtin', () => {
    const entry = scratch.writePlugin('shadow', `return { output: {} };`);
    const registry = PluginRegistry.empty();
    open.track(registry);
    expect(() =>
      registry.addRemote(loadRemotePlugin(manifest('AgentNode'), entry)),
    ).toThrow(/builtin Agent Spec type/);
  });
});

function nodeAndComponentManifest(
  componentSchema?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    name: 'test-plugin',
    version: '1.0.0',
    components: [
      { componentType: 'GateNode', kind: 'node' },
      { componentType: 'Policy', kind: 'component', schema: componentSchema },
    ],
  };
}

const POLICY = {
  component_type: 'Policy',
  id: 'pol',
  name: 'strict',
  rule: 'deny',
};

describe("kind: 'component'", () => {
  it('is neither a node nor a transform to the compiler', () => {
    const entry = scratch.writePlugin('kindonly', `return { output: {} };`);
    const registry = PluginRegistry.empty();
    open.track(registry);
    registry.addRemote(loadRemotePlugin(nodeAndComponentManifest(), entry));

    expect(registry.kindOf('Policy')).toBe('component');
    expect(registry.nodeDef('Policy')).toBeUndefined();
    expect(registry.transformDef('Policy')).toBeUndefined();
  });

  it('reaches its parent node as data, and is never executed itself', async () => {
    const entry = scratch.writePlugin(
      'holder',
      `globalThis.__asked ??= [];
       if (msg.params.componentType) globalThis.__asked.push(msg.params.componentType);
       return { output: { policy: msg.params.node.policy,
                          asked: globalThis.__asked.slice() } };`,
    );

    const state = await runFlow(
      flowUsing('GateNode', { policy: POLICY }),
      entry,
      nodeAndComponentManifest(),
      { text: 'hello' },
      {},
      5000,
    );

    expect(state.asked).toEqual(['GateNode']);
    expect(state.policy).toMatchObject({
      componentType: 'Policy',
      name: 'strict',
      rule: 'deny',
    });
  });

  it('is validated against its manifest schema when its parent is parsed', async () => {
    const entry = scratch.writePlugin('schemaonly', `return { output: {} };`);
    const registry = PluginRegistry.empty();
    open.track(registry);
    registry.addRemote(
      loadRemotePlugin(
        nodeAndComponentManifest({ type: 'object', required: ['rule'] }),
        entry,
      ),
    );

    const policy = { component_type: 'Policy', id: 'pol', name: 'strict' };
    expect(() =>
      parseFlow(flowUsing('GateNode', { policy }), registry),
    ).toThrow(/Policy "strict": "rule" is required/);
  });

  it('is refused by kind when it is put in a node slot', () => {
    const entry = scratch.writePlugin('inaslot', `return { output: {} };`);
    const registry = PluginRegistry.empty();
    open.track(registry);
    registry.addRemote(loadRemotePlugin(nodeAndComponentManifest(), entry));

    expect(() => parseFlow(flowUsing('Policy'), registry)).toThrow(
      /provides as a component rather than a node/,
    );
  });
});

const SHELL_PLUGIN = [
  "q='\"'",
  'while IFS= read -r line; do',
  '  rest=${line#*${q}id${q}:}',
  '  id=${rest%%,*}',
  '  rest=${line#*${q}text${q}:${q}}',
  '  text=${rest%%${q}*}',
  '  printf \'{"id":%s,"result":{"output":{"shell":"%s"}}}\\n\' "$id" "$text"',
  'done',
].join('\n');

function writeShellPlugin(
  name: string,
  { selfStarting, extension = '.sh' }: { selfStarting: boolean; extension?: string },
): string {
  const entry = join(scratch.path, `${name}${extension}`);
  writeFileSync(entry, `${selfStarting ? '#!/bin/sh\n' : ''}${SHELL_PLUGIN}\n`);
  chmodSync(entry, selfStarting ? 0o755 : 0o644);
  return entry;
}

describe('a plugin that is not a JavaScript module', () => {
  it('runs an executable entry point by path', async () => {
    const entry = writeShellPlugin('executable', { selfStarting: true });
    const state = await runWith('ShellNode', entry, manifest('ShellNode'), {
      text: 'from the shell',
    });

    expect(state).toMatchObject({ shell: 'from the shell' });
  });

  it('starts a plugin the way its manifest says to', async () => {
    const entry = writeShellPlugin('interpreted', {
      selfStarting: false,
      extension: '.plugin',
    });
    const state = await runWith(
      'ShellNode',
      entry,
      { ...manifest('ShellNode'), command: ['/bin/sh', 'interpreted.plugin'] },
      { text: 'via an interpreter' },
    );

    expect(state).toMatchObject({ shell: 'via an interpreter' });
  });

  it('leaves a bare interpreter name for the OS to resolve', async () => {
    const entry = writeShellPlugin('bareinterp', {
      selfStarting: false,
      extension: '.plugin',
    });
    const state = await runWith(
      'ShellNode',
      entry,
      { ...manifest('ShellNode'), command: ['sh', 'bareinterp.plugin'] },
      { text: 'no path needed' },
    );

    expect(state).toMatchObject({ shell: 'no path needed' });
  });

  it('resolves a relative interpreter against the plugin directory', async () => {
    const entry = writeShellPlugin('shipped', {
      selfStarting: false,
      extension: '.plugin',
    });
    const launcher = join(scratch.path, 'launch.sh');
    writeFileSync(launcher, '#!/bin/sh\nexec /bin/sh "$1"\n');
    chmodSync(launcher, 0o755);

    const state = await runWith(
      'ShellNode',
      entry,
      { ...manifest('ShellNode'), command: ['./launch.sh', 'shipped.plugin'] },
      { text: 'through a launcher' },
    );

    expect(state).toMatchObject({ shell: 'through a launcher' });
  });

  it('refuses an entry point it has no way to start, and says how to fix it', () => {
    const entry = writeShellPlugin('unstartable', {
      selfStarting: false,
      extension: '.plugin',
    });

    expect(() => loadRemotePlugin(manifest('ShellNode'), entry)).toThrow(
      /is not executable and is not a \.mjs\/\.js file/,
    );
    expect(() => loadRemotePlugin(manifest('ShellNode'), entry)).toThrow(
      /make it executable with a shebang, or set "command" in the manifest/,
    );
  });

  it('reports an entry point that is not there', () => {
    expect(() =>
      loadRemotePlugin(manifest('ShellNode'), join(scratch.path, 'absent.mjs')),
    ).toThrow(/is not accessible/);
  });

  it('refuses a "command" that is not an array of strings', () => {
    const entry = writeShellPlugin('badcommand', { selfStarting: true });
    expect(() =>
      loadRemotePlugin({ ...manifest('ShellNode'), command: 'sh plugin.sh' }, entry),
    ).toThrow(/"command" that is not a non-empty string array/);
  });
});

function hangingGraph(componentType: string, name: string) {
  const entry = scratch.writePlugin(name, `return new Promise(() => {});`);
  const registry = PluginRegistry.empty();
  open.track(registry);
  registry.addRemote(loadRemotePlugin(manifest(componentType), entry, { timeout: 60_000 }));

  const pf = parseFlow(flowUsing(componentType), registry);
  const graph = compile(pf, {
    plugins: registry,
    scratchWorkspace: createScratchWorkspace,
  });
  validate(graph);
  return graph;
}

describe('aborting a run that is inside a plugin call', () => {
  it('stops waiting when the caller aborts', async () => {
    const runner = new Runner(hangingGraph('HangAbortNode', 'hang-abort'), {
      ...DEFAULT_RUNNER_OPTIONS,
      verbose: false,
    });

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 100);
    const started = Date.now();
    try {
      await expect(runner.run(ac.signal, { text: 'hello' })).rejects.toThrow(
        /when the run ended/,
      );
    } finally {
      clearTimeout(timer);
    }
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("stops waiting when the run's own budget runs out", async () => {
    const runner = new Runner(hangingGraph('HangBudgetNode', 'hang-budget'), {
      ...DEFAULT_RUNNER_OPTIONS,
      verbose: false,
      timeout: 200,
    });

    const started = Date.now();
    await expect(runner.run(undefined, { text: 'hello' })).rejects.toThrow(
      /when the run ended/,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('does not start a plugin for a run that is already over', async () => {
    const entry = scratch.writePlugin('never-started', `return { output: {} };`);
    const registry = PluginRegistry.empty();
    open.track(registry);
    const remote = loadRemotePlugin(manifest('NeverNode'), entry, { timeout: 60_000 });
    registry.addRemote(remote);

    await expect(
      remote.host.call(
        'execute',
        {
          componentType: 'NeverNode',
          node: { componentType: 'NeverNode', name: 'p' },
          input: {},
          workspace: scratch.path,
        },
        { signal: AbortSignal.abort() },
      ),
    ).rejects.toThrow(/the run was already over/);
  });
});

interface StubSession {
  session: SandboxSession;
  wraps: { toolPath: string; args: string[] | undefined }[];
  cleanups: string[];
}

function stubSession(): StubSession {
  const wraps: StubSession['wraps'] = [];
  const cleanups: string[] = [];
  const session: SandboxSession = {
    name: 'stub',
    workspace: {
      root: scratch.path,
      bin: join(scratch.path, '.heddle', 'bin'),
      grants: () => [],
      toolPaths: () => [],
      dispose: () => {},
    },
    wrap(toolPath, args) {
      wraps.push({ toolPath, args });
      return {
        command: toolPath,
        args: args ?? [],
        env: { HEDDLE_SANDBOX: '1', HEDDLE_STUB_BASE: 'floor' },
        cwd: scratch.path,
        cleanup: () => cleanups.push(toolPath),
      };
    },
    dispose: () => {},
  };
  return { session, wraps, cleanups };
}

describe('spawning a plugin under a sandbox', () => {
  function spawnUnder(
    name: string,
    componentType: string,
    body: string,
    env?: Record<string, string>,
  ): {
    entry: string;
    stub: StubSession;
    host: { dispose(): void };
    execute: () => Promise<unknown>;
  } {
    const entry = scratch.writePlugin(name, body);
    const stub = stubSession();
    const registry = open.track(PluginRegistry.empty());
    const remote = loadRemotePlugin(manifest(componentType), entry, {
      session: stub.session,
      timeout: 5000,
      ...(env ? { env } : {}),
    });
    registry.addRemote(remote);

    return {
      entry,
      stub,
      host: remote.host,
      execute: () =>
        remote.host.call('execute', {
          componentType,
          node: { componentType, name: 'p' },
          input: {},
          workspace: scratch.path,
        }),
    };
  }

  it('hands the sandbox the program and its arguments separately', async () => {
    const { entry, stub, execute } = spawnUnder(
      'sandboxed',
      'SandboxedNode',
      `return { output: { ok: true } };`,
    );

    const result = await execute();

    expect(result).toMatchObject({ output: { ok: true } });
    expect(stub.wraps).toHaveLength(1);
    expect(stub.wraps[0].toolPath).toBe(process.execPath);

    // The program and its arguments stay apart, which is the property here: a
    // backend that had to re-split a command line would have to guess at
    // quoting. The runtime rides in the arguments as a `data:` URL rather than
    // as a path, so a confined plugin needs no read grant to receive it.
    const args = stub.wraps[0].args;
    expect(args, 'the wrapped command carried no arguments').toBeDefined();
    expect(args![0]).toBe('--import');
    expect(args![1]).toMatch(/^data:text\/javascript,/);
    expect(args![2]).toBe(entry);
  });

  const ENV_PROBE = `return { output: { base: process.env.HEDDLE_STUB_BASE ?? 'absent' } };`;

  it.each([
    ['the environment the backend built for it', undefined, 'floor'],
    ['the caller-named override of the sandbox base', { HEDDLE_STUB_BASE: 'chosen' }, 'chosen'],
  ])('gives the plugin %s', async (_what, env, base) => {
    const { execute } = spawnUnder(`sandbox-env-${base}`, 'EnvNode', ENV_PROBE, env);

    await expect(execute()).resolves.toMatchObject({ output: { base } });
  });

  it('releases the sandbox scratch when the plugin is disposed', async () => {
    const { stub, host, execute } = spawnUnder(
      'sandbox-cleanup',
      'CleanNode',
      `return { output: {} };`,
    );

    await execute();
    expect(stub.cleanups).toEqual([]);

    host.dispose();
    expect(stub.cleanups).toEqual([process.execPath]);
  });
});

describe('isolation', () => {
  it('runs the plugin somewhere other than the heddle process', async () => {
    const entry = scratch.writePlugin('pid', `return { output: { pid: process.pid } };`);
    const state = await runWith('PidNode', entry, manifest('PidNode'));

    expect(typeof state.pid).toBe('number');
    expect(state.pid).not.toBe(process.pid);
  });

  it('does not hand the plugin the server environment', async () => {
    process.env.HEDDLE_TEST_SECRET = 'super-secret-value';
    try {
      const entry = scratch.writePlugin(
        'env',
        `return { output: { secret: process.env.HEDDLE_TEST_SECRET ?? null,
                            keys: Object.keys(process.env) } };`,
      );
      const state = await runWith('EnvNode', entry, manifest('EnvNode'));

      expect(state.secret).toBeNull();

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
    const entry = scratch.writePlugin(
      'planter',
      `globalThis.__planted ??= [];
       if (msg.params.input.plant) globalThis.__planted.push(msg.params.input.plant);
       return { output: { seen: globalThis.__planted.slice() } };`,
    );
    const m = manifest('PlanterNode');

    const first = await runWith('PlanterNode', entry, m, { plant: 'run-one-secret' });
    expect(first.seen).toEqual(['run-one-secret']);

    const second = await runWith('PlanterNode', entry, m, {});
    expect(second.seen).toEqual([]);
  });

  it('keeps two concurrent runs from seeing each other', async () => {
    const entry = scratch.writePlugin(
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
    const entry = scratch.writePlugin('suicide', `process.exit(1);`);
    await expect(runWith('SuicideNode', entry, manifest('SuicideNode'))).rejects.toThrow(
      /exited/,
    );
    expect(process.pid).toBeGreaterThan(0);
  });

  it('stops the plugin process when the registry is disposed', async () => {
    const entry = scratch.writePlugin('lives', `return { output: {} };`);
    const registry = PluginRegistry.empty();
    const remote = loadRemotePlugin(manifest('LivesNode'), entry, { timeout: 5000 });
    registry.addRemote(remote);

    await remote.host.call('execute', {
      componentType: 'LivesNode',
      node: {},
      input: {},
      workspace: scratch.path,
    });

    registry.dispose();

    await expect(
      remote.host.call('execute', {
        componentType: 'LivesNode',
        node: {},
        input: {},
        workspace: scratch.path,
      }),
    ).rejects.toThrow(/disposed/);
  });
});

function agentFlowWithTransform(
  componentType: string,
  component: Record<string, unknown> = {},
): string {
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
        outputs: [{ title: 'query', type: 'string' }],
      },
      a: {
        component_type: 'AgentNode',
        id: 'a',
        name: 'a',
        agent: {
          component_type: 'Agent',
          id: 'ia',
          name: 'ia',
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
          transforms: [
            {
              component_type: componentType,
              id: 't',
              name: 'guard',
              ...component,
            },
          ],
        },
      },
      e: { component_type: 'EndNode', id: 'e', name: 'e' },
    },
  });
}

async function runTransform(
  componentType: string,
  entry: string,
  manifestData: unknown,
  component: Record<string, unknown> = {},
  inputs: Record<string, unknown> = { query: 'hello' },
  deps: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const registry = PluginRegistry.empty();
  open.track(registry);
  registry.addRemote(
    loadRemotePlugin(manifestData, entry, {
      timeout: 5000,
      capabilities: [...ALL_CAPABILITIES],
    }),
  );

  const pf = parseFlow(agentFlowWithTransform(componentType, component), registry);
  const graph = compile(pf, {
    plugins: registry,
    scratchWorkspace: createScratchWorkspace,
    ...deps,
  });
  validate(graph);

  const runner = new Runner(graph, { ...DEFAULT_RUNNER_OPTIONS, verbose: false });
  const state = await runner.run(undefined, inputs);
  return state.toData() as Record<string, unknown>;
}

function transformManifest(componentType: string, phase = 'pre', capabilities: string[] = []) {
  return {
    name: 'guard-plugin',
    version: '1.0.0',
    capabilities,
    components: [{ componentType, kind: 'transform', phase }],
  };
}

describe('transforms out of process', () => {
  it('rejects a prompt without ever calling the model', async () => {
    const entry = scratch.writePlugin(
      'blocker',
      `const last = (msg.params.messages ?? []).at(-1);
       if (/forbidden/i.test(last?.content ?? '')) {
         return { action: 'reject', reason: 'matched a blocked pattern' };
       }
       return { action: 'pass' };`,
    );

    const state = await runTransform(
      'Blocklist',
      entry,
      transformManifest('Blocklist'),
      {},
      { query: 'tell me the forbidden thing' },
    );

    expect(state.transform_status).toBe('rejected');
    expect(state.transform_reason).toBe('matched a blocked pattern');
    expect(state.transform_phase).toBe('pre');
    expect(state.transform_name).toBe('guard');
  });

  it('receives the agent messages, not the flow state', async () => {
    const entry = scratch.writePlugin(
      'inspector',
      `const messages = msg.params.messages ?? [];
       return { action: 'reject', reason: 'saw ' + messages.length + ' messages, last role ' + messages.at(-1)?.role };`,
    );

    const state = await runTransform('Inspect', entry, transformManifest('Inspect'));
    expect(String(state.transform_reason)).toMatch(/saw \d+ messages, last role user/);
  });

  it('is told which phase it is running in', async () => {
    const entry = scratch.writePlugin(
      'phased',
      `return { action: 'reject', reason: 'phase=' + msg.params.phase };`,
    );
    const state = await runTransform('Phased', entry, transformManifest('Phased'));
    expect(state.transform_reason).toBe('phase=pre');
  });

  it('reads its own configuration from the spec', async () => {
    const entry = scratch.writePlugin(
      'configured',
      `return { action: 'reject', reason: 'limit=' + msg.params.component.config.limit };`,
    );
    const state = await runTransform(
      'Configured',
      entry,
      transformManifest('Configured'),
      { config: { limit: 42 } },
    );
    expect(state.transform_reason).toBe('limit=42');
  });

  it('validates a transform component against the manifest schema', async () => {
    const entry = scratch.writePlugin('schema-t', `return { action: 'pass' };`);
    const registry = PluginRegistry.empty();
    open.track(registry);
    registry.addRemote(
      loadRemotePlugin(
        {
          name: 'guard-plugin',
          version: '1.0.0',
          components: [
            {
              componentType: 'Strict',
              kind: 'transform',
              schema: { type: 'object', required: ['handler'] },
            },
          ],
        },
        entry,
      ),
    );

    expect(() => parseFlow(agentFlowWithTransform('Strict'), registry)).toThrow(
      /"handler" is required/,
    );
  });

  it('rejects a result that is not a known action', async () => {
    const entry = scratch.writePlugin('badaction', `return { action: 'explode' };`);
    await expect(
      runTransform('BadAction', entry, transformManifest('BadAction')),
    ).rejects.toThrow(/expected pass, modify or reject/);
  });

  it('rejects a "modify" that carries no messages', async () => {
    const entry = scratch.writePlugin('badmodify', `return { action: 'modify' };`);
    await expect(
      runTransform('BadModify', entry, transformManifest('BadModify')),
    ).rejects.toThrow(/without "messages"/);
  });

  it('runs a tool on the transform behalf', async () => {
    const entry = scratch.writePlugin(
      'classify',
      `const verdict = await runTool('classify', { text: (msg.params.messages ?? []).at(-1)?.content });
       return { action: 'reject', reason: 'classifier said ' + verdict.label };`,
    );

    const state = await runTransform(
      'Classifier',
      entry,
      transformManifest('Classifier', 'pre', ['runTool']),
      {},
      { query: 'hello' },
      {
        toolRegistry: {
          lookup: (name: string) =>
            name === 'classify' ? { name, description: '', impl: { kind: 'path' as const, path: '/classify' } } : undefined,
          all: () => [],
        },
        toolExecutor: {
          execute: async (_s: unknown, _p: string, input: Record<string, unknown>) => ({
            output: { label: `unsafe(${String(input.text).length} chars)` },
            stderr: '',
          }),
        },
      },
    );

    expect(state).toMatchObject({ transform_status: 'rejected' });
    expect(String(state.transform_reason)).toMatch(/classifier said unsafe\(\d+ chars\)/);
  });

  it('tells a transform it has no tool access when the flow configured none', async () => {
    const entry = scratch.writePlugin(
      'toolless',
      `try { await runTool('classify', {}); return { action: 'pass' }; }
       catch (e) { return { action: 'reject', reason: e.message }; }`,
    );

    const state = await runTransform(
      'Toolless',
      entry,
      transformManifest('Toolless', 'pre', ['runTool']),
    );
    expect(String(state.transform_reason)).toMatch(/no tool registry configured/);
  });

  it('gives a transform none of the server environment', async () => {
    process.env.HEDDLE_TRANSFORM_SECRET = 'nope';
    try {
      const entry = scratch.writePlugin(
        'envguard',
        `return { action: 'reject', reason: 'secret=' + (process.env.HEDDLE_TRANSFORM_SECRET ?? 'absent') };`,
      );
      const state = await runTransform('EnvGuard', entry, transformManifest('EnvGuard'));
      expect(state.transform_reason).toBe('secret=absent');
    } finally {
      delete process.env.HEDDLE_TRANSFORM_SECRET;
    }
  });
});
