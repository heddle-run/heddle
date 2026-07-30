import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandbox } from '../index.js';
import { DEFAULT_SANDBOX_POLICY } from '../types.js';
import { SubprocessExecutor } from '../../tool/executor.js';

function backendAvailable(): boolean {
  if (process.platform === 'darwin') return true;
  if (process.platform !== 'linux') return false;
  return !spawnSync('bwrap', ['--version'], { stdio: 'ignore' }).error;
}

function writeProbeTool(dir: string): string {
  const path = join(dir, 'probe.sh');
  writeFileSync(
    path,
    `#!/bin/sh
REAL_HOME='${homedir()}'
INPUT=$(cat)
probe() { if "$@" >/dev/null 2>&1; then echo true; else echo false; fi; }
cat <<EOF
{
  "echoed": $INPUT,
  "readHome": $(probe ls "$REAL_HOME"),
  "readCwd": $(probe ls .),
  "writeCwd": $(probe touch ./sandbox-escape),
  "writeTmp": $(probe touch "$TMPDIR/scratch-ok"),
  "writeHome": $(probe touch "$HOME/home-ok"),
  "sawPeerFile": $(probe test -f "$HEDDLE_WORKSPACE/from-tool"),
  "writeWorkspace": $(probe touch "$HEDDLE_WORKSPACE/from-tool"),
  "workspace": "$HEDDLE_WORKSPACE",
  "marker": "$HEDDLE_SANDBOX"
}
EOF
`,
    { mode: 0o755 },
  );
  return path;
}

describe.runIf(backendAvailable())('sandbox enforcement', () => {
  const sandboxDir = mkdtempSync(join(tmpdir(), 'heddle-enforce-'));
  const probe = writeProbeTool(sandboxDir);

  function makeExecutor(policyOverrides = {}) {
    const sandbox = createSandbox('auto', {
      ...DEFAULT_SANDBOX_POLICY,
      readPaths: [sandboxDir],
      cwd: sandboxDir,
      ...policyOverrides,
    });
    return new SubprocessExecutor({ sandbox });
  }

  async function run(policyOverrides = {}) {
    const result = await makeExecutor(policyOverrides).execute(undefined, probe, {
      hello: 'world',
    });
    return result.output as Record<string, unknown>;
  }

  it('passes input and output through the sandbox boundary', async () => {
    const out = await run();
    expect(out.echoed).toEqual({ hello: 'world' });
    expect(out.marker).toBe('1');
  });

  it('denies access to the real home directory', async () => {
    const out = await run();
    expect(out.readHome).toBe(false);
    expect(out.writeHome).toBe(true);
  });

  it('allows reading the working directory but not writing it', async () => {
    const out = await run();
    expect(out.readCwd).toBe(true);
    expect(out.writeCwd).toBe(false);
  });

  it('gives the tool a writable scratch directory', async () => {
    const out = await run();
    expect(out.writeTmp).toBe(true);
  });

  it('makes the working directory writable when explicitly allowed', async () => {
    const out = await run({ writePaths: [sandboxDir] });
    expect(out.writeCwd).toBe(true);
  });

  it('does not leak the real home directory into the sandbox env', async () => {
    const sandbox = createSandbox('auto', { ...DEFAULT_SANDBOX_POLICY, cwd: sandboxDir });
    const session = sandbox.session('probe');
    const cmd = session.wrap(probe);
    expect(cmd.env.HOME).not.toBe(homedir());
    cmd.cleanup?.();
    session.dispose();
  });
});

describe.runIf(backendAvailable())('sandbox session scoping', () => {
  const sandboxDir = mkdtempSync(join(tmpdir(), 'heddle-scope-'));
  const probe = writeProbeTool(sandboxDir);

  function makeExecutor() {
    return new SubprocessExecutor({
      sandbox: createSandbox('auto', {
        ...DEFAULT_SANDBOX_POLICY,
        readPaths: [sandboxDir],
        cwd: sandboxDir,
      }),
    });
  }

  async function callIn(executor: SubprocessExecutor) {
    const result = await executor.execute(undefined, probe, {});
    return result.output as Record<string, unknown>;
  }

  it('shares one workspace across tool calls in the same scope', async () => {
    const scope = makeExecutor().beginScope('agent-a');
    try {
      const first = await callIn(scope.executor as SubprocessExecutor);
      const second = await callIn(scope.executor as SubprocessExecutor);

      expect(first.sawPeerFile).toBe(false);
      expect(first.writeWorkspace).toBe(true);
      expect(second.sawPeerFile).toBe(true);
      expect(second.workspace).toBe(first.workspace);
    } finally {
      scope.dispose();
    }
  });

  it('isolates one agent scope from another', async () => {
    const executor = makeExecutor();
    const a = executor.beginScope('agent-a');
    const b = executor.beginScope('agent-b');
    try {
      const inA = await callIn(a.executor as SubprocessExecutor);
      const inB = await callIn(b.executor as SubprocessExecutor);

      expect(inA.writeWorkspace).toBe(true);
      expect(inA.workspace).not.toBe(inB.workspace);
      expect(inB.sawPeerFile).toBe(false);
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  it('destroys the workspace when the scope ends', async () => {
    const scope = makeExecutor().beginScope('agent-done');
    const out = await callIn(scope.executor as SubprocessExecutor);
    expect(existsSync(out.workspace as string)).toBe(true);

    scope.dispose();
    expect(existsSync(out.workspace as string)).toBe(false);
  });

  it('still confines calls made outside any scope', async () => {
    const out = await callIn(makeExecutor());
    expect(out.marker).toBe('1');
    expect(out.readHome).toBe(false);
    expect(existsSync(out.workspace as string)).toBe(false);
  });
});
