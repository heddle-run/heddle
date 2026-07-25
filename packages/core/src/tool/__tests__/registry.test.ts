import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileRegistry } from '../registry.js';

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `specrun-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('FileRegistry', () => {
  it('discovers executable tools', () => {
    const dir = makeTempDir();

    for (const name of ['tool_a.sh', 'tool_b.py', 'tool_c']) {
      writeFileSync(join(dir, name), '#!/bin/bash\n', { mode: 0o755 });
    }

    // Non-executable file
    writeFileSync(join(dir, 'readme.txt'), 'not a tool', { mode: 0o644 });

    const reg = FileRegistry.create(dir);

    expect(reg.all().length).toBe(3);

    expect(reg.lookup('tool_a')).toBeDefined();
    expect(reg.lookup('tool_b')).toBeDefined();
    expect(reg.lookup('tool_c')).toBeDefined();
    expect(reg.lookup('readme')).toBeUndefined();
  });

  it('creates empty registry for empty string', () => {
    const reg = FileRegistry.create('');
    expect(reg.all().length).toBe(0);
  });

  it('validates tools exist', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'existing_tool.sh'), '#!/bin/bash\n', {
      mode: 0o755,
    });

    const reg = FileRegistry.create(dir);

    expect(() => reg.validateTools(['existing_tool'])).not.toThrow();
    expect(() =>
      reg.validateTools(['existing_tool', 'missing_tool']),
    ).toThrow();
  });
});
