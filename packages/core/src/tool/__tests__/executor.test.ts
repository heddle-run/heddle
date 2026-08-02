import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SubprocessExecutor } from '../executor.js';

const made: string[] = [];

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'heddle-executor-test-'));
  made.push(dir);
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
