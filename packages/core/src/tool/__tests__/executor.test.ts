import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SubprocessExecutor } from '../executor.js';

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `specrun-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('SubprocessExecutor', () => {
  it('executes a tool and parses JSON output', async () => {
    const dir = makeTempDir();
    const toolPath = join(dir, 'test_tool.sh');
    const script = `#!/usr/bin/env bash
INPUT=$(cat)
echo "{\\"echo\\": $INPUT}"
`;
    writeFileSync(toolPath, script, { mode: 0o755 });

    const exec = new SubprocessExecutor();
    const result = await exec.execute(undefined, toolPath, {
      message: 'hello',
    });

    expect(result.output['echo']).toBeDefined();
    const echoMap = result.output['echo'] as Record<string, unknown>;
    expect(echoMap['message']).toBe('hello');
  });

  it('returns error for failing tool', async () => {
    const dir = makeTempDir();
    const toolPath = join(dir, 'fail_tool.sh');
    const script = `#!/usr/bin/env bash
echo "something went wrong" >&2
exit 1
`;
    writeFileSync(toolPath, script, { mode: 0o755 });

    const exec = new SubprocessExecutor();
    await expect(exec.execute(undefined, toolPath, {})).rejects.toThrow();
  });
});
