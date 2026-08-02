import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command } from 'commander';
import { bundleCommand } from '../bundle.js';
import { runCommand } from '../run.js';
import { validateCommand } from '../validate.js';

const repoRoot = join(import.meta.dirname, '../../../../../');
const FLOW = join(repoRoot, 'examples/ag-ui/flow.json');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'heddle-cli-bundle-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Captured {
  stdout: string;
  stderr: string;
}

async function invoke(command: Command, args: string[]): Promise<Captured> {
  let stdout = '';
  let stderr = '';

  const spies = [
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    }),
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    }),
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      stdout += `${line}\n`;
    }),
    vi.spyOn(console, 'error').mockImplementation((line: string) => {
      stderr += `${line}\n`;
    }),
  ];

  try {
    await command.parseAsync(args, { from: 'user' });
  } finally {
    for (const spy of spies) spy.mockRestore();
  }

  return { stdout, stderr };
}

function fixtures(): { toolsDir: string; dataDir: string } {
  const toolsDir = join(dir, 'tools');
  mkdirSync(toolsDir);
  writeFileSync(join(toolsDir, 'greet.py'), '#!/usr/bin/env python3\nprint("{}")\n');
  chmodSync(join(toolsDir, 'greet.py'), 0o755);

  const dataDir = join(dir, 'data');
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, 'facts.md'), '# facts');

  return { toolsDir, dataDir };
}

async function pack(...extra: string[]): Promise<{ out: string } & Captured> {
  const { toolsDir, dataDir } = fixtures();
  const out = join(dir, 'demo.heddle');

  const captured = await invoke(bundleCommand, [
    FLOW,
    '--tools-dir',
    toolsDir,
    '--mount',
    `${dataDir}:knowledge`,
    '--input',
    '{"query":"from-bundle"}',
    '-o',
    out,
    ...extra,
  ]);

  return { out, ...captured };
}

describe('heddle bundle', () => {
  it('packs a flow with its tools and mounts, and says what it wrote', async () => {
    const { out, stdout } = await pack();

    expect(existsSync(out)).toBe(true);
    expect(stdout).toContain('Flow: ag-ui-demo (flow.json)');
    expect(stdout).toContain('Mounts: knowledge (ro)');
    expect(stdout).toContain('Default input: recorded');
    expect(stdout).toContain(`Wrote ${out}`);
    expect(stdout).toContain(`Run it anywhere with: heddle run ${out}`);
  });

  it('refuses an in-process plugin, naming why it cannot travel', async () => {
    await expect(
      invoke(bundleCommand, [FLOW, '--plugin', './plugin.mjs']),
    ).rejects.toThrow(/cannot carry its closure/);
  });

  it('refuses to bundle a bundle', async () => {
    const { out } = await pack();
    await expect(invoke(bundleCommand, [out])).rejects.toThrow(
      /already a bundle/,
    );
  });
});

describe('heddle run <bundle>', () => {
  it('runs a bundle with the input it recorded', async () => {
    const { out } = await pack();

    const { stdout } = await invoke(runCommand, [out]);
    expect(JSON.parse(stdout)).toEqual({ query: 'from-bundle' });
  });

  it('lets the caller\'s --input override the recorded one', async () => {
    const { out } = await pack();

    const { stdout } = await invoke(runCommand, [
      out,
      '--input',
      '{"query":"mine"}',
    ]);
    expect(JSON.parse(stdout)).toEqual({ query: 'mine' });
  });

  it('refuses a file with the extension but not the format', async () => {
    const fake = join(dir, 'fake.heddle');
    writeFileSync(fake, '{"not":"a bundle"}');

    await expect(invoke(runCommand, [fake])).rejects.toThrow(
      /does not start with gzip/,
    );
  });
});

describe('heddle validate <bundle>', () => {
  it('validates what the bundle carries', async () => {
    const { out } = await pack();

    const { stdout } = await invoke(validateCommand, [out]);
    expect(stdout).toContain('Parsed Flow: ag-ui-demo');
    expect(stdout).toContain('Graph validation passed');
    // The verdict names the bundle the caller typed, not the temp directory
    // it was opened into.
    expect(stdout).toContain(`Valid: ${out}`);
  });
});
