import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
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
import { validateManifest } from '../manifest.js';
import { PluginRegistry } from '../registry.js';
import { withRuntime } from '../runtime-source.js';
import { createWorkspaceFactory } from '../../workspace/index.js';
import type { Workspace } from '../../workspace/index.js';
import { PluginError } from '../../errors.js';

let scratch: string;
const registries: PluginRegistry[] = [];
const opened: Workspace[] = [];

/** A component type nothing else claims, so a files collision is what fails. */
function componentTypeFor(name: string): string {
  return `C${name.replace(/[^A-Za-z0-9]/g, '')}`;
}

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'heddle-pfiles-')));
});

afterEach(() => {
  while (opened.length) opened.pop()!.dispose();
});

afterAll(() => {
  while (registries.length) registries.pop()!.dispose();
  rmSync(scratch, { recursive: true, force: true });
});

/** A plugin directory with a `skills/` folder beside its entry point. */
function shipPlugin(name: string, files: unknown): string {
  const root = join(scratch, name);
  mkdirSync(join(root, 'skills'), { recursive: true });
  writeFileSync(join(root, 'skills', 'tidy.md'), 'Tidying a CSV\n');
  const componentType = componentTypeFor(name);
  writeFileSync(
    join(root, 'plugin.mjs'),
    withRuntime(`serve({ ${componentType}: { execute: () => ({ output: {} }) } });`),
  );
  chmodSync(join(root, 'plugin.mjs'), 0o755);

  writeFileSync(
    join(root, 'plugin.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      capabilities: [],
      components: [{ componentType, kind: 'component' }],
      files,
    }),
  );

  return root;
}

function load(root: string): PluginRegistry {
  const manifest = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf-8'));
  const registry = PluginRegistry.empty();
  registry.addRemote(
    loadRemotePlugin(validateManifest(manifest), join(root, 'plugin.mjs'), {
      root,
      timeout: 10_000,
    }),
  );
  registries.push(registry);
  return registry;
}

describe('a plugin that ships files', () => {
  it('offers them as read-only mounts, named after itself', () => {
    const registry = load(shipPlugin('skills-a', [{ path: 'skills' }]));

    expect(registry.workspaceMounts()).toEqual([
      {
        source: join(scratch, 'skills-a', 'skills'),
        dest: 'skills',
        mode: 'ro',
        origin: 'plugin "skills-a"',
      },
    ]);
  });

  it('puts them in every node\'s workspace', () => {
    const registry = load(shipPlugin('skills-b', [{ path: 'skills', dest: 'procedures' }]));
    const factory = createWorkspaceFactory({ mounts: registry.workspaceMounts() });

    const ws = factory.create('agent');
    opened.push(ws);

    expect(readFileSync(join(ws.root, 'procedures', 'tidy.md'), 'utf-8')).toBe(
      'Tidying a CSV\n',
    );
  });

  /**
   * A plugin ships files; it does not get a writable channel onto the
   * operator's disk. The same line the capability set draws, in the one place a
   * manifest could otherwise have reached past it.
   */
  it('never gets a writable one', () => {
    const registry = load(shipPlugin('skills-c', [{ path: 'skills' }]));

    for (const mount of registry.workspaceMounts()) {
      expect(mount.mode).toBe('ro');
    }
  });

  it('costs nothing to read: loading starts no process', () => {
    // `loadRemotePlugin` reads the manifest as data and constructs a lazy host.
    // If resolving files had needed the plugin running, this would hang or fail.
    const registry = load(shipPlugin('skills-d', [{ path: 'skills' }]));
    expect(registry.workspaceMounts()).toHaveLength(1);
  });
});

describe('what a manifest may not say about files', () => {
  it('a path outside the plugin\'s own directory', () => {
    const root = shipPlugin('escaper', [{ path: '../elsewhere' }]);
    mkdirSync(join(scratch, 'elsewhere'), { recursive: true });

    expect(() => load(root)).toThrow(PluginError);
    expect(() => load(root)).toThrow(/outside the plugin's own directory/);
  });

  it('a path that resolves out through a link', () => {
    const root = shipPlugin('linker', [{ path: 'sneaky' }]);
    mkdirSync(join(scratch, 'target'), { recursive: true });
    symlinkSync(join(scratch, 'target'), join(root, 'sneaky'));

    expect(() => load(root)).toThrow(/outside the plugin's own directory/);
  });

  it('a path that is not there', () => {
    expect(() => load(shipPlugin('absent', [{ path: 'missing' }]))).toThrow(
      /not there beside the plugin/,
    );
  });

  /**
   * `onlyOn` arrived at from the other side: a field belonging to the plugin,
   * written on a component, is read by nothing.
   */
  it('files on a component rather than on the plugin', () => {
    expect(() =>
      validateManifest({
        name: 'misplaced',
        version: '1.0.0',
        capabilities: [],
        components: [
          { componentType: 'Skills', kind: 'component', files: [{ path: 'skills' }] },
        ],
      }),
    ).toThrow(/which is the plugin's rather than a component's/);
  });

  it('two of its own files landing on one path', () => {
    expect(() =>
      validateManifest({
        name: 'greedy',
        version: '1.0.0',
        capabilities: [],
        components: [{ componentType: 'Skills', kind: 'component' }],
        files: [
          { path: 'a', dest: 'skills' },
          { path: 'b', dest: 'skills' },
        ],
      }),
    ).toThrow(/two files landing on "skills"/);
  });

  /**
   * A plugin that declares only files is a directory, and heddle already has a
   * way to put a directory in a workspace without loading anybody's code.
   */
  it('files and nothing else', () => {
    expect(() =>
      validateManifest({
        name: 'just-data',
        version: '1.0.0',
        capabilities: [],
        files: [{ path: 'skills' }],
      }),
    ).toThrow(/mount it with --mount and load no code at all/);
  });
});

describe('two plugins wanting one workspace path', () => {
  it('is refused, naming both', () => {
    const registry = load(shipPlugin('first', [{ path: 'skills' }]));
    const second = shipPlugin('second', [{ path: 'skills' }]);
    const manifest = JSON.parse(readFileSync(join(second, 'plugin.json'), 'utf-8'));

    expect(() =>
      registry.addRemote(
        loadRemotePlugin(validateManifest(manifest), join(second, 'plugin.mjs'), {
          root: second,
          timeout: 10_000,
        }),
      ),
    ).toThrow(/plugin "first".*plugin "second"|plugin "second".*plugin "first"/s);
  });

  /**
   * Names carry over, so request code cannot take a path an installed plugin
   * claimed — the same property `extend` already gives component types.
   */
  it('still collides across an extended registry', () => {
    const registry = load(shipPlugin('installed', [{ path: 'skills' }]));
    const layered = registry.extend();

    expect(layered.workspaceMounts()).toHaveLength(1);

    const submitted = shipPlugin('submitted', [{ path: 'skills' }]);
    const manifest = JSON.parse(readFileSync(join(submitted, 'plugin.json'), 'utf-8'));

    expect(() =>
      layered.addRemote(
        loadRemotePlugin(validateManifest(manifest), join(submitted, 'plugin.mjs'), {
          root: submitted,
          timeout: 10_000,
        }),
      ),
    ).toThrow(/two things want "skills"/);
  });
});
