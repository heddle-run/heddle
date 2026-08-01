import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
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
import { createWorkspaceFactory } from '../factory.js';
import { assertNoCollisions, parseMount } from '../mount.js';
import type { Mount, Workspace } from '../types.js';
import { WorkspaceError } from '../../errors.js';

let host: string;
const opened: Workspace[] = [];

beforeEach(() => {
  // Resolved, because everything downstream reports resolved paths — `/var` on
  // macOS is really `/private/var`, and a test holding the other one compares
  // two spellings of the same directory.
  host = realpathSync(mkdtempSync(join(tmpdir(), 'heddle-mount-host-')));
});

afterEach(() => {
  while (opened.length) opened.pop()!.dispose();
  rmSync(host, { recursive: true, force: true });
});

function give(path: string, contents = 'x'): string {
  const full = join(host, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, contents);
  return full;
}

function mounted(mounts: Mount[], label = 'agent'): Workspace {
  const factory = createWorkspaceFactory({ mounts });
  const workspace = factory.create(label);
  opened.push(workspace);
  return workspace;
}

describe('what --mount accepts', () => {
  it('defaults the destination to the source name, and the mode to read-only', () => {
    const source = give('skills/tidy.md');

    expect(parseMount(join(host, 'skills'))).toEqual({
      source: join(host, 'skills'),
      dest: 'skills',
      mode: 'ro',
      origin: '--mount',
    });
    expect(parseMount(source).dest).toBe('tidy.md');
  });

  it('takes a destination, a mode, or both', () => {
    give('report.csv');

    expect(parseMount(`${join(host, 'report.csv')}:input.csv`)).toMatchObject({
      dest: 'input.csv',
      mode: 'ro',
    });
    expect(parseMount(`${join(host, 'report.csv')}:notes:rw`)).toMatchObject({
      dest: 'notes',
      mode: 'rw',
    });
    expect(parseMount(`${join(host, 'report.csv')}::rw`)).toMatchObject({
      dest: 'report.csv',
      mode: 'rw',
    });
  });
});

describe('what --mount refuses, before the run starts', () => {
  it('a source that is not there', () => {
    expect(() => parseMount(join(host, 'absent'))).toThrow(WorkspaceError);
    expect(() => parseMount(join(host, 'absent'))).toThrow(/is not there/);
  });

  it('a destination that is absolute or climbs out', () => {
    give('data.csv');
    const source = join(host, 'data.csv');

    expect(() => parseMount(`${source}:/etc/passwd`)).toThrow(/absolute path/);
    expect(() => parseMount(`${source}:../escaped`)).toThrow(/climbs out/);
  });

  it('a destination under the reserved directory', () => {
    give('evil');

    expect(() => parseMount(`${join(host, 'evil')}:.heddle/bin/read_file`)).toThrow(
      /reserves/,
    );
    expect(() => parseMount(`${join(host, 'evil')}:.heddle`)).toThrow(/reserves/);
  });

  /**
   * Followed, a link would mount whatever it points at — which is not what the
   * operator wrote, and is outside every guarantee the workspace makes.
   */
  it('a symbolic link, rather than following it', () => {
    mkdirSync(join(host, 'tree'));
    writeFileSync(join(host, 'secret'), 'not yours');
    symlinkSync(join(host, 'secret'), join(host, 'tree', 'link'));

    expect(() =>
      mounted([{ source: join(host, 'tree'), dest: 'tree', mode: 'ro', origin: '--mount' }]),
    ).toThrow(/symbolic link/);
  });

  it('two mounts that would land on top of each other', () => {
    const one: Mount = { source: '/a', dest: 'skills', mode: 'ro', origin: '--mount' };
    const two: Mount = { source: '/b', dest: 'skills', mode: 'ro', origin: 'plugin "x"' };

    expect(() => assertNoCollisions([one, two])).toThrow(/two things want "skills"/);
    // Named, because one of them is often a plugin the operator did not write.
    expect(() => assertNoCollisions([one, two])).toThrow(/plugin "x"/);
  });

  it('a mount nested inside another, not just an identical one', () => {
    const outer: Mount = { source: '/a', dest: 'skills', mode: 'ro', origin: '--mount' };
    const inner: Mount = {
      source: '/b',
      dest: join('skills', 'extra'),
      mode: 'ro',
      origin: '--mount',
    };

    expect(() => assertNoCollisions([outer, inner])).toThrow(/two things want/);
  });

  it('a tree over the budget', () => {
    for (let i = 0; i < 5; i++) give(`big/file-${i}`, 'x'.repeat(100));

    expect(() =>
      createWorkspaceFactory({
        mounts: [{ source: join(host, 'big'), dest: 'big', mode: 'ro', origin: '--mount' }],
        budget: { maxBytes: 200, maxEntries: 4096 },
      }),
    ).toThrow(/over 200 bytes/);

    expect(() =>
      createWorkspaceFactory({
        mounts: [{ source: join(host, 'big'), dest: 'big', mode: 'ro', origin: '--mount' }],
        budget: { maxBytes: 1_000_000, maxEntries: 3 },
      }),
    ).toThrow(/more than 3 files/);
  });
});

describe('a read-only mount', () => {
  it('is in every scope, and the same in each', () => {
    give('skills/tidy.md', 'wash the data');
    const mounts: Mount[] = [
      { source: join(host, 'skills'), dest: 'skills', mode: 'ro', origin: '--mount' },
    ];

    const factory = createWorkspaceFactory({ mounts });
    const a = factory.create('agent-a');
    const b = factory.create('agent-b');
    opened.push(a, b);

    for (const ws of [a, b]) {
      expect(readFileSync(join(ws.root, 'skills', 'tidy.md'), 'utf-8')).toBe(
        'wash the data',
      );
    }
  });

  it('is granted read-only, after the writable root it sits inside', () => {
    give('skills/tidy.md');
    const ws = mounted([
      { source: join(host, 'skills'), dest: 'skills', mode: 'ro', origin: '--mount' },
    ]);

    expect(ws.grants()).toEqual([
      { path: ws.root, access: 'write' },
      { path: join(ws.root, '.heddle'), access: 'read' },
      { path: join(ws.root, 'skills'), access: 'read' },
    ]);
  });

  it('does not carry an edit back to the host', () => {
    give('skills/tidy.md', 'original');
    const ws = mounted([
      { source: join(host, 'skills'), dest: 'skills', mode: 'ro', origin: '--mount' },
    ]);

    writeFileSync(join(ws.root, 'skills', 'tidy.md'), 'scribbled on');
    ws.dispose();

    expect(readFileSync(join(host, 'skills', 'tidy.md'), 'utf-8')).toBe('original');
  });
});

describe('a read-write mount', () => {
  function writable(): Mount {
    return {
      source: join(host, 'notes'),
      dest: 'notes',
      mode: 'rw',
      origin: '--mount',
    };
  }

  it('carries back what the run changed, and what it added', () => {
    give('notes/kept.md', 'unchanged');
    give('notes/edited.md', 'before');

    const ws = mounted([writable()]);
    writeFileSync(join(ws.root, 'notes', 'edited.md'), 'after');
    writeFileSync(join(ws.root, 'notes', 'added.md'), 'new');
    ws.dispose();

    expect(readFileSync(join(host, 'notes', 'edited.md'), 'utf-8')).toBe('after');
    expect(readFileSync(join(host, 'notes', 'added.md'), 'utf-8')).toBe('new');
    expect(readFileSync(join(host, 'notes', 'kept.md'), 'utf-8')).toBe('unchanged');
  });

  /**
   * The model's `rm -rf` in a scratch directory must not become deletion of the
   * operator's files. The operator's directory is the one thing here that is
   * not disposable.
   */
  it('does not carry back a deletion', () => {
    give('notes/keep.md', 'still here');

    const ws = mounted([writable()]);
    rmSync(join(ws.root, 'notes', 'keep.md'));
    ws.dispose();

    expect(existsSync(join(host, 'notes', 'keep.md'))).toBe(true);
  });

  it('says so when it writes over a host file that moved under the run', () => {
    give('notes/contested.md', 'before');
    const warnings: string[] = [];

    const factory = createWorkspaceFactory({
      mounts: [writable()],
      onWarn: (message) => warnings.push(message),
    });
    const ws = factory.create('agent');

    writeFileSync(join(ws.root, 'notes', 'contested.md'), 'the run wrote this');
    writeFileSync(join(host, 'notes', 'contested.md'), 'somebody else wrote this');
    ws.dispose();

    expect(readFileSync(join(host, 'notes', 'contested.md'), 'utf-8')).toBe(
      'the run wrote this',
    );
    expect(warnings.join('\n')).toContain('changed on disk while the run was using it');
  });

  it('shows a later scope what an earlier one wrote back', () => {
    give('notes/log.md', 'first');
    const factory = createWorkspaceFactory({ mounts: [writable()] });

    const first = factory.create('agent-a');
    writeFileSync(join(first.root, 'notes', 'log.md'), 'second');
    first.dispose();

    const second = factory.create('agent-b');
    opened.push(second);

    expect(readFileSync(join(second.root, 'notes', 'log.md'), 'utf-8')).toBe('second');
  });

  it('works for a mount that is one file', () => {
    give('notes.md', 'before');
    const ws = mounted([
      { source: join(host, 'notes.md'), dest: 'notes.md', mode: 'rw', origin: '--mount' },
    ]);

    writeFileSync(join(ws.root, 'notes.md'), 'after');
    ws.dispose();

    expect(readFileSync(join(host, 'notes.md'), 'utf-8')).toBe('after');
  });

  it('reports rather than throws when it cannot copy back', () => {
    give('notes/a.md', 'x');
    const warnings: string[] = [];

    const factory = createWorkspaceFactory({
      mounts: [writable()],
      onWarn: (message) => warnings.push(message),
    });
    const ws = factory.create('agent');

    // The run's own error is the one worth having; a workspace that threw in
    // the `finally` would replace it with one about a directory.
    rmSync(join(ws.root, 'notes'), { recursive: true, force: true });

    expect(() => ws.dispose()).not.toThrow();
    expect(warnings.join('\n')).toContain('could not copy "notes" back');
  });
});
