/**
 * A plugin as a source of tools.
 *
 * Before this the only source was a directory of executables, where a tool's
 * name was its filename and its description was the empty string. These tests
 * are mostly about the two things that make a second source safe: that a name
 * cannot be taken quietly, and that a tool which merely *claims* to exist is
 * caught at load rather than partway through a run.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRemotePlugin } from '../remote-loader.js';
import { PluginRegistry } from '../registry.js';
import { withRuntime } from '../runtime-source.js';
import { invokeTool } from '../../tool/invoke.js';
import { composeRegistries, FileRegistry } from '../../tool/registry.js';
import { buildToolDefinitions, buildToolSchema } from '../../node/agent.js';
import { SubprocessExecutor } from '../../tool/executor.js';
import type { Registry, ToolDef } from '../../tool/types.js';
import type { ToolSpec } from '../../spec/types.js';

let scratch: string;
const open: PluginRegistry[] = [];

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'heddle-tools-'));
});

afterAll(() => {
  for (const registry of open) registry.dispose();
  rmSync(scratch, { recursive: true, force: true });
});

function plugin(name: string, body: string): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, 'plugin.mjs');
  writeFileSync(entry, withRuntime(body));
  return entry;
}

/** An executable tool beside a plugin, reading JSON on stdin as tools do. */
function executable(entry: string, name: string, output: string): string {
  const path = join(entry, '..', name);
  writeFileSync(
    path,
    `#!/usr/bin/env node\nlet s='';process.stdin.on('data',c=>s+=c);` +
      `process.stdin.on('end',()=>{process.stdout.write(JSON.stringify(${output}))});\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

function manifest(tools: unknown[], components: unknown[] = []): unknown {
  return { name: 'toolbox', version: '1.0.0', capabilities: [], components, tools };
}

function load(rawManifest: unknown, entry: string): PluginRegistry {
  const registry = PluginRegistry.empty();
  open.push(registry);
  registry.addRemote(loadRemotePlugin(rawManifest, entry, {}));
  return registry;
}

// ---------------------------------------------------------------------------
// The two ways a tool can exist.
// ---------------------------------------------------------------------------

describe('a tool a plugin ships as an executable', () => {
  it('runs as any other tool does, through the subprocess executor', async () => {
    const entry = plugin('exec-form', 'serve({});');
    executable(entry, 'shout', '{ loud: true }');

    const registry = load(manifest([{ name: 'shout', path: './shout' }]), entry);
    const tool = registry.toolRegistry().lookup('shout')!;

    expect(tool.impl.kind).toBe('path');
    const result = await invokeTool(undefined, tool, {}, new SubprocessExecutor());
    expect(result.output).toEqual({ loud: true });
  });

  it('refuses one that resolves outside the plugin directory', () => {
    const entry = plugin('escape', 'serve({});');
    // A real program, so the containment check is what refuses it rather than
    // the file simply not being there — those are two different refusals and
    // this is the one being asserted.
    const outside = join(scratch, 'escape-target.sh');
    writeFileSync(outside, '#!/bin/sh\ntrue\n');
    chmodSync(outside, 0o755);

    expect(() =>
      load(manifest([{ name: 'reach', path: '../escape-target.sh' }]), entry),
    ).toThrow(/outside the plugin's own directory/);
  });

  it('refuses one that is simply not there, with a different message', () => {
    const entry = plugin('escape-missing', 'serve({});');
    expect(() => load(manifest([{ name: 'curl', path: '../../../bin/sh' }]), entry)).toThrow(
      /not there beside the plugin/,
    );
  });

  it('refuses a symlink that leaves the plugin directory', () => {
    // String arithmetic on the path would pass this; only resolving it does not.
    const entry = plugin('symlink', 'serve({});');
    const outside = join(scratch, 'outside.sh');
    writeFileSync(outside, '#!/bin/sh\ntrue\n');
    chmodSync(outside, 0o755);
    symlinkSync(outside, join(entry, '..', 'inside'));

    expect(() => load(manifest([{ name: 'sneak', path: './inside' }]), entry)).toThrow(
      /outside the plugin's own directory/,
    );
  });

  it('refuses one that is not executable, at load rather than at the call', () => {
    const entry = plugin('not-exec', 'serve({});');
    writeFileSync(join(entry, '..', 'inert'), 'not a program');
    expect(() => load(manifest([{ name: 'inert', path: './inert' }]), entry)).toThrow(
      /not executable/,
    );
  });

  it('refuses one that is not there at all', () => {
    const entry = plugin('missing', 'serve({});');
    expect(() => load(manifest([{ name: 'ghost', path: './ghost' }]), entry)).toThrow(
      /not there beside the plugin/,
    );
  });
});

describe('a tool the plugin itself implements', () => {
  const COMPONENT = [{ componentType: 'Proxy', kind: 'component' }];

  it('runs in the plugin process, with no executor configured at all', async () => {
    const entry = plugin(
      'impl-form',
      `serve({}, { tools: { search: async (input) => ({ output: { hits: [input.q] } }) } });`,
    );
    const registry = load(
      manifest([{ name: 'search', componentType: 'Proxy' }], COMPONENT),
      entry,
    );
    const tool = registry.toolRegistry().lookup('search')!;

    expect(tool.impl.kind).toBe('plugin');
    // The point of the kind: no tools directory, no subprocess, no exec bit.
    const result = await invokeTool(undefined, tool, { q: 'heddle' }, undefined);
    expect(result.output).toEqual({ hits: ['heddle'] });
  });

  it('reports a tool declared in the manifest but not served', async () => {
    const entry = plugin('impl-missing', 'serve({}, { tools: {} });');
    const registry = load(
      manifest([{ name: 'absent', componentType: 'Proxy' }], COMPONENT),
      entry,
    );
    const tool = registry.toolRegistry().lookup('absent')!;

    await expect(invokeTool(undefined, tool, {}, undefined)).rejects.toThrow(
      /declares the tool "absent" in its manifest but serves no handler/,
    );
  });

  it('refuses a result that is not an object of named values', async () => {
    const entry = plugin(
      'impl-bad',
      `serve({}, { tools: { bare: async () => ({ output: 'a string' }) } });`,
    );
    const registry = load(
      manifest([{ name: 'bare', componentType: 'Proxy' }], COMPONENT),
      entry,
    );
    const tool = registry.toolRegistry().lookup('bare')!;

    await expect(invokeTool(undefined, tool, {}, undefined)).rejects.toThrow(
      /returned no "output" object/,
    );
  });

  it('refuses a manifest naming a component the plugin does not declare', () => {
    const entry = plugin('impl-typo', 'serve({});');
    expect(() =>
      load(manifest([{ name: 'search', componentType: 'Proxie' }], COMPONENT), entry),
    ).toThrow(/which this plugin does not declare/);
  });
});

// ---------------------------------------------------------------------------
// What a manifest may not say.
// ---------------------------------------------------------------------------

describe('what the manifest refuses', () => {
  it('refuses a tool with both a path and a componentType, or neither', () => {
    const entry = plugin('both', 'serve({});');
    expect(() =>
      load(
        manifest(
          [{ name: 't', path: './x', componentType: 'Proxy' }],
          [{ componentType: 'Proxy', kind: 'component' }],
        ),
        entry,
      ),
    ).toThrow(/exactly one of "path".*It has both/s);

    expect(() => load(manifest([{ name: 't' }]), entry)).toThrow(/It has neither/);
  });

  it('refuses a tool name that is not one a spec could write', () => {
    const entry = plugin('badname', 'serve({});');
    expect(() => load(manifest([{ name: 'my tool', path: './x' }]), entry)).toThrow(
      /a tool's "name" must match/,
    );
  });

  it('refuses the same tool declared twice', () => {
    const entry = plugin('dupe', 'serve({});');
    executable(entry, 'twice', '{}');
    expect(() =>
      load(manifest([{ name: 'twice', path: './twice' }, { name: 'twice', path: './twice' }]), entry),
    ).toThrow(/declares the tool "twice" twice/);
  });

  it('refuses a schema too large to send on every round', () => {
    const entry = plugin('fat-schema', 'serve({});');
    executable(entry, 'fat', '{}');
    const huge = { type: 'object', description: 'x'.repeat(70_000) };
    expect(() =>
      load(manifest([{ name: 'fat', path: './fat', inputSchema: huge }]), entry),
    ).toThrow(/over heddle's/);
  });

  it('loads a plugin whose whole content is tools', () => {
    // The shape an MCP proxy has: no node, no transform, no middleware.
    const entry = plugin('tools-only', 'serve({});');
    executable(entry, 'only', '{}');
    const registry = load(manifest([{ name: 'only', path: './only' }]), entry);
    expect(registry.toolRegistry().all().map((t) => t.name)).toEqual(['only']);
  });
});

describe('two plugins wanting one name', () => {
  it('is a load error rather than a matter of --plugin order', () => {
    const first = plugin('claim-a', 'serve({});');
    executable(first, 'search', '{}');
    const second = plugin('claim-b', 'serve({});');
    executable(second, 'search', '{}');

    const registry = PluginRegistry.empty();
    open.push(registry);
    registry.addRemote(
      loadRemotePlugin({ ...(manifest([{ name: 'search', path: './search' }]) as object), name: 'alpha' }, first, {}),
    );

    expect(() =>
      registry.addRemote(
        loadRemotePlugin({ ...(manifest([{ name: 'search', path: './search' }]) as object), name: 'beta' }, second, {}),
      ),
    ).toThrow(/both provide the tool "search"/);
  });
});

// ---------------------------------------------------------------------------
// What the model is told.
// ---------------------------------------------------------------------------

describe('the tool definitions the model receives', () => {
  const spec = (t: Partial<ToolSpec>): ToolSpec =>
    ({ componentType: 'ServerTool', name: 'search', ...t }) as ToolSpec;

  function registryWith(tool: Partial<ToolDef>): Registry {
    const def: ToolDef = {
      name: 'search',
      description: '',
      impl: { kind: 'path', path: '/search' },
      ...tool,
    } as ToolDef;
    return { lookup: (n) => (n === def.name ? def : undefined), all: () => [def] };
  }

  it('fills a description the spec left blank', () => {
    const [def] = buildToolDefinitions(
      [spec({})],
      registryWith({ description: 'searches the index' }),
      () => {},
    );
    expect(def.description).toBe('searches the index');
  });

  it('keeps the spec description and says so when the two disagree', () => {
    const warnings: string[] = [];
    const [def] = buildToolDefinitions(
      [spec({ description: 'finds things' })],
      registryWith({ description: 'searches the index', origin: 'plugin:mcp' }),
      (m) => warnings.push(m),
    );
    expect(def.description).toBe('finds things');
    expect(warnings[0]).toMatch(/described one way in the flow and another by plugin:mcp/);
  });

  it('uses a registry schema when the spec declared no inputs', () => {
    const schema = { type: 'object', properties: { q: { type: 'string' } }, required: [] };
    const [def] = buildToolDefinitions([spec({})], registryWith({ inputSchema: schema }), () => {});
    expect(def.parameters).toEqual(schema);
  });

  it('never merges the two, because the spec marks everything required', () => {
    const declared = spec({
      inputs: [{ title: 'q', jsonSchema: { title: 'q', type: 'string' } }],
    } as Partial<ToolSpec>);
    const [def] = buildToolDefinitions(
      [declared],
      registryWith({ inputSchema: { type: 'object', properties: { extra: { type: 'string' } } } }),
      () => {},
    );
    expect(def.parameters).toEqual(buildToolSchema(declared));
    expect((def.parameters as { properties: object }).properties).not.toHaveProperty('extra');
  });

  it('shows the model only what the flow named, whatever the registry holds', () => {
    const defs = buildToolDefinitions([spec({})], registryWith({}), () => {});
    expect(defs.map((d) => d.name)).toEqual(['search']);
  });

  it('does not mark an input with a default as required', () => {
    const schema = buildToolSchema({
      componentType: 'ServerTool',
      name: 'page',
      inputs: [
        { title: 'q', jsonSchema: { title: 'q', type: 'string' } },
        { title: 'limit', jsonSchema: { title: 'limit', type: 'integer', default: 10 } },
      ],
    } as ToolSpec);
    expect(schema.required).toEqual(['q']);
  });
});

// ---------------------------------------------------------------------------
// What an adversarial review of the first draft found.
// ---------------------------------------------------------------------------

describe('the plugin root is the manifest directory', () => {
  it('resolves command, cwd and tool paths against the manifest, not the interpreter', () => {
    // The shape that broke it: a manifest naming an interpreter that lives
    // nowhere near the plugin. Taken as the root, `/bin` would be where tool
    // paths resolve — so the plugin's own tools are refused and any system
    // binary passes the containment check.
    const dir = join(scratch, 'rooted');
    mkdirSync(join(dir, 'tools'), { recursive: true });
    const shipped = join(dir, 'tools', 'x');
    writeFileSync(shipped, '#!/bin/sh\ntrue\n');
    chmodSync(shipped, 0o755);
    writeFileSync(
      join(dir, 'plugin.json'),
      JSON.stringify({
        name: 'rooted',
        version: '1.0.0',
        command: ['/bin/sh', 'server.sh'],
        components: [],
        tools: [{ name: 'x', path: './tools/x' }],
      }),
    );
    writeFileSync(join(dir, 'server.sh'), '#!/bin/sh\ncat > /dev/null\n');

    const registry = PluginRegistry.empty();
    open.push(registry);
    registry.addRemote(
      loadRemotePlugin(
        JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf-8')),
        '/bin/sh',
        { root: dir },
      ),
    );

    const tool = registry.toolRegistry().lookup('x')!;
    // realpath'd, which on macOS turns /var into /private/var.
    expect(tool.impl).toEqual({ kind: 'path', path: realpathSync(shipped) });
  });

  it('refuses a system binary that a wrong root would have admitted', () => {
    const dir = join(scratch, 'rooted-deny');
    mkdirSync(dir, { recursive: true });
    expect(() =>
      loadRemotePlugin(
        { name: 'r', version: '1.0.0', components: [], tools: [{ name: 'sh', path: './sh' }] },
        '/bin/sh',
        { root: dir },
      ),
    ).toThrow(/not there beside the plugin/);
  });
});

describe('a tool path that is not a program', () => {
  it('refuses a directory, which carries the execute bit for being traversable', () => {
    const entry = plugin('dir-tool', 'serve({});');
    mkdirSync(join(entry, '..', 'nested'), { recursive: true });
    expect(() => load(manifest([{ name: 'nested', path: './nested' }]), entry)).toThrow(
      /which is a directory/,
    );
  });
});

describe('two plugins reporting one manifest name', () => {
  it('cannot slip a tool collision past the guard by agreeing on a string', () => {
    const first = plugin('same-a', 'serve({});');
    executable(first, 'dup', '{}');
    const second = plugin('same-b', 'serve({});');
    executable(second, 'dup', '{}');

    const registry = PluginRegistry.empty();
    open.push(registry);
    const same = { name: 'twins', version: '1.0.0', capabilities: [], components: [] };
    registry.addRemote(
      loadRemotePlugin({ ...same, tools: [{ name: 'dup', path: './dup' }] }, first, {}),
    );
    expect(() =>
      registry.addRemote(
        loadRemotePlugin({ ...same, tools: [{ name: 'dup', path: './dup' }] }, second, {}),
      ),
    ).toThrow(/both provide the tool "dup"/);
  });
});

describe('a plugin tool colliding with another source', () => {
  function pluginTool(name: string, shadows?: boolean): ToolDef {
    return {
      name,
      description: '',
      origin: 'plugin:mcp',
      shadows,
      impl: { kind: 'plugin', plugin: 'mcp', call: async () => ({ output: {}, stderr: '' }) },
    };
  }
  const asRegistry = (tools: ToolDef[]): Registry => ({
    lookup: (n) => tools.find((t) => t.name === n),
    all: () => tools,
  });
  const fileTool: ToolDef = {
    name: 'search',
    description: '',
    origin: 'dir:/opt/tools',
    impl: { kind: 'path', path: '/opt/tools/search' },
  };

  it('is refused rather than resolved by argument order', () => {
    expect(() =>
      composeRegistries([asRegistry([pluginTool('search')]), asRegistry([fileTool])]),
    ).toThrow(/two sources provide the tool "search"/);
  });

  it('is refused in the other direction too, since losing a name matters as much', () => {
    expect(() =>
      composeRegistries([asRegistry([fileTool]), asRegistry([pluginTool('search')])]),
    ).toThrow(/two sources provide the tool "search"/);
  });

  it('is allowed when the manifest said so in writing', () => {
    const merged = composeRegistries([
      asRegistry([pluginTool('search', true)]),
      asRegistry([fileTool]),
    ]);
    expect(merged.lookup('search')?.origin).toBe('dir:/opt/tools');
  });
});

describe('composing sources', () => {
  it('lets a later source shadow an earlier one, and reports it', () => {
    const shadowed: string[] = [];
    const a: Registry = {
      lookup: () => undefined,
      all: () => [{ name: 'echo', description: 'a', impl: { kind: 'path', path: '/a' } }],
    };
    const b: Registry = {
      lookup: () => undefined,
      all: () => [{ name: 'echo', description: 'b', impl: { kind: 'path', path: '/b' } }],
    };

    const merged = composeRegistries([a, b], (tool) => shadowed.push(tool.name));
    expect(merged.lookup('echo')?.description).toBe('b');
    expect(shadowed).toEqual(['echo']);
  });

  it('is the identity for a single source', () => {
    const only = FileRegistry.create('');
    expect(composeRegistries([only])).toBe(only);
  });
});
