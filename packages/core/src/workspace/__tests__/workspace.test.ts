import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createScratchWorkspace, createWorkspaceFactory } from '../factory.js';
import { RESERVED_DIR } from '../workspace.js';
import { workspaceEnv } from '../env.js';
import type { Workspace } from '../types.js';
import { SubprocessExecutor } from '../../tool/executor.js';

const opened: Workspace[] = [];

/** A real program, so a link in `bin` has something to point at. */
let probeToolPath: string;
let probeDir: string;

beforeAll(() => {
  probeDir = mkdtempSync(join(tmpdir(), 'heddle-bin-'));
  probeToolPath = join(probeDir, 'probe.sh');
  writeFileSync(probeToolPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
});

afterAll(() => {
  rmSync(probeDir, { recursive: true, force: true });
});

afterEach(() => {
  while (opened.length) opened.pop()!.dispose();
});

function track(workspace: Workspace): Workspace {
  opened.push(workspace);
  return workspace;
}

describe('the layout a tool can rely on', () => {
  it('is a root, with one reserved directory inside it, hidden', () => {
    const ws = track(createScratchWorkspace('agent'));

    expect(existsSync(ws.root)).toBe(true);
    expect(existsSync(ws.bin)).toBe(true);
    expect(ws.bin).toBe(join(ws.root, RESERVED_DIR, 'bin'));
  });

  /**
   * `mkdtemp` in `/var` on macOS is really `/private/var`. A workspace that
   * reported one while the process it belongs to sat in the other would make
   * every confinement check disagree with itself — including the one every
   * workspace-rooted tool script does, which `realpath`s both sides before
   * deciding whether a path is inside.
   */
  it('reports a resolved root, so every reader agrees on the path', () => {
    const ws = track(createScratchWorkspace('agent'));

    expect(ws.root).toBe(realpathSync(ws.root));
  });

  it('tells a tool where it is and puts bin first on PATH', () => {
    const ws = track(createScratchWorkspace('agent'));
    const env = workspaceEnv(ws, '/usr/bin:/bin');

    expect(env.HEDDLE_WORKSPACE).toBe(ws.root);
    expect(env.HEDDLE_WORKSPACE_BIN).toBe(ws.bin);
    expect(env.PATH).toBe(`${ws.bin}:/usr/bin:/bin`);
  });

  it('is still a usable PATH when there was nothing to prepend to', () => {
    const ws = track(createScratchWorkspace('agent'));

    expect(workspaceEnv(ws, undefined).PATH).toBe(ws.bin);
    expect(workspaceEnv(ws, '').PATH).toBe(ws.bin);
  });

  it('grants the root writable and the reserved directory read-only, in that order', () => {
    const ws = track(createScratchWorkspace('agent'));
    const grants = ws.grants();

    expect(grants).toEqual([
      { path: ws.root, access: 'write' },
      { path: join(ws.root, RESERVED_DIR), access: 'read' },
    ]);
  });
});

describe('the tools in bin', () => {
  it('are links named after the tool, not after the file', () => {
    const ws = track(
      createWorkspaceFactory().create('agent', [
        { name: 'read_file', target: probeToolPath },
      ]),
    );

    const link = join(ws.bin, 'read_file');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(probeToolPath));
  });

  /**
   * Not copies. A copy would break a tool that reads a data file beside itself,
   * because `realpath(__file__)` would land in a directory holding only its
   * siblings.
   */
  it('report the host directories they point into', () => {
    const ws = track(
      createWorkspaceFactory().create('agent', [
        { name: 'probe', target: probeToolPath },
      ]),
    );

    expect(ws.toolPaths()).toEqual([realpathSync(dirname(probeToolPath))]);
  });

  /**
   * A plugin-served tool is not a program. Silence would tell the model it does
   * not exist, and it does — so the shim says which problem this actually is.
   */
  it('leave an explaining shim where a plugin-served tool would be', () => {
    const ws = track(
      createWorkspaceFactory().create('agent', [
        { name: 'read_skill', servedBy: 'skills' },
      ]),
    );

    const shim = join(ws.bin, 'read_skill');
    const result = spawnSync(shim, { encoding: 'utf-8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is not a program');
    expect(result.stderr).toContain('"skills"');
    // No target, so nothing outside the workspace has to be reachable for it.
    expect(ws.toolPaths()).toEqual([]);
  });

  it('are absent when nothing was handed over', () => {
    const ws = track(createWorkspaceFactory().create('agent'));

    expect(readdirSync(ws.bin)).toEqual([]);
    expect(ws.toolPaths()).toEqual([]);
  });
});

describe('a factory, per scope', () => {
  it('names the workspace after the owning node', () => {
    const ws = track(createWorkspaceFactory().create('Research Agent'));

    expect(ws.root).toContain('Research-Agent');
  });

  it('gives separate scopes separate workspaces', () => {
    const factory = createWorkspaceFactory();
    const a = track(factory.create('agent-a'));
    const b = track(factory.create('agent-b'));

    expect(a.root).not.toBe(b.root);
  });

  it('removes the workspace on dispose', () => {
    const ws = createWorkspaceFactory().create('temp');
    expect(existsSync(ws.root)).toBe(true);

    ws.dispose();
    expect(existsSync(ws.root)).toBe(false);
  });
});

describe('a workspace directory the operator named', () => {
  let kept: string;

  beforeAll(() => {
    kept = mkdtempSync(join(tmpdir(), 'heddle-kept-'));
  });

  afterAll(() => {
    rmSync(kept, { recursive: true, force: true });
  });

  it('keeps what the run produced', () => {
    const ws = createWorkspaceFactory({ root: kept }).create('agent');
    writeFileSync(join(ws.root, 'result.txt'), 'kept');

    ws.dispose();

    expect(existsSync(ws.root)).toBe(true);
    expect(readFileSync(join(ws.root, 'result.txt'), 'utf-8')).toBe('kept');
  });

  it('still gives each scope its own directory, named after the node', () => {
    const factory = createWorkspaceFactory({ root: kept });
    const a = factory.create('writer');
    const b = factory.create('reader');

    expect(a.root).toBe(join(realpathSync(kept), 'writer'));
    expect(b.root).toBe(join(realpathSync(kept), 'reader'));
  });

  /**
   * A loop can arrive at one node several times and each arrival is its own
   * scope. Numbering them keeps that visible, instead of the second arrival
   * opening the first one's directory and reading files it was not given.
   */
  it('numbers a node a loop arrives at twice', () => {
    const factory = createWorkspaceFactory({ root: kept });
    const first = factory.create('looper');
    const second = factory.create('looper');

    expect(second.root).toBe(`${first.root}-2`);
  });
});

/**
 * The asymmetry this whole change exists to close.
 *
 * A workspace used to be something `--safe` produced, so the same flow run
 * locally dropped its tools into heddle's own working directory — which was
 * then the whole of what the model could reach. There is no sandbox anywhere in
 * this block.
 */
describe('a scope without a sandbox', () => {
  let scratch: string;
  let probe: string;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'heddle-unconfined-'));
    probe = join(scratch, 'probe.sh');
    writeFileSync(
      probe,
      `#!/bin/sh
cat >/dev/null
touch ./from-cwd
printf '{"cwd":"%s","workspace":"%s","bin":"%s","sawPeer":%s}' \\
  "$PWD" "$HEDDLE_WORKSPACE" "$HEDDLE_WORKSPACE_BIN" \\
  "$(test -f ./from-cwd && echo true || echo false)"
`,
      { mode: 0o755 },
    );
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('opens one anyway, and starts the tool in it', async () => {
    const scope = new SubprocessExecutor().beginScope('agent');
    try {
      const { output } = await scope.executor.execute(undefined, probe, {});

      expect(output.workspace).toBe(scope.workspace);
      expect(output.cwd).toBe(scope.workspace);
      expect(output.bin).toBe(join(scope.workspace, RESERVED_DIR, 'bin'));
    } finally {
      scope.dispose();
    }
  });

  it('lets two tools in one scope hand each other a file', async () => {
    const scope = new SubprocessExecutor().beginScope('agent');
    try {
      await scope.executor.execute(undefined, probe, {});
      const second = await scope.executor.execute(undefined, probe, {});

      expect(second.output.sawPeer).toBe(true);
    } finally {
      scope.dispose();
    }
  });

  it('shows a different scope an empty one', async () => {
    const executor = new SubprocessExecutor();
    const a = executor.beginScope('agent-a');
    const b = executor.beginScope('agent-b');

    try {
      await a.executor.execute(undefined, probe, {});

      expect(b.workspace).not.toBe(a.workspace);
      expect(existsSync(join(b.workspace, 'from-cwd'))).toBe(false);
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  it('takes the workspace away when the scope ends', async () => {
    const scope = new SubprocessExecutor().beginScope('agent-done');
    await scope.executor.execute(undefined, probe, {});

    scope.dispose();

    expect(existsSync(scope.workspace)).toBe(false);
  });

  /**
   * A bare `ToolNode` opens no scope. It used to get a throwaway *session*; it
   * now gets a throwaway workspace with it, so a tool never runs without one.
   */
  it('gives an unscoped call a workspace of its own, and takes it back', async () => {
    const { output } = await new SubprocessExecutor().execute(
      undefined,
      probe,
      {},
    );

    expect(output.workspace).toBeTruthy();
    expect(existsSync(output.workspace as string)).toBe(false);
  });
});
