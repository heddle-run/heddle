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
import { mergeBundleOptions, openBundle, type OpenedBundle } from '../bundles.js';
import { honourBundleChat, runCommand } from '../run.js';
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

describe('a bundle that recorded --interactive', () => {
  it('carries the proposal from pack through open', async () => {
    const { out } = await pack('--interactive');
    const bundle = openBundle(out);
    try {
      expect(bundle.interactive).toBe(true);
    } finally {
      bundle.dispose();
    }
  });

  it('a bundle packed without it proposes nothing', async () => {
    const { out } = await pack();
    const opened = openBundle(out);
    try {
      expect(opened.interactive).toBeUndefined();
    } finally {
      opened.dispose();
    }
  });

  type Options = Parameters<typeof honourBundleChat>[0];
  const emptyOptions = (over: Partial<Options> = {}): Options => ({
    allowRead: [],
    allowWrite: [],
    allowEnv: [],
    mount: [],
    ...over,
  });

  it('opens the chat at a terminal, and only there', () => {
    const bundle = { name: 'demo', interactive: true } as OpenedBundle;

    const atTerminal = emptyOptions();
    honourBundleChat(atTerminal, bundle, true);
    expect(atTerminal.interactive).toBe(true);

    const piped = emptyOptions();
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      honourBundleChat(piped, bundle, false);
      expect(piped.interactive).toBeUndefined();
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('runs its recorded input once'),
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it('yields to everything the caller typed', () => {
    const bundle = { name: 'demo', interactive: true } as OpenedBundle;

    const cases: Options[] = [
      emptyOptions({ input: '{"query":"typed"}' }),
      emptyOptions({ protocol: 'ag-ui' }),
      emptyOptions({ resume: true }),
      emptyOptions({ answer: '{"approved":true}' }),
      emptyOptions({ interactive: false }),
    ];
    for (const options of cases) {
      const before = { ...options };
      honourBundleChat(options, bundle, true);
      expect(options).toEqual(before);
    }

    const plainBundle = emptyOptions();
    honourBundleChat(plainBundle, { name: 'demo' } as OpenedBundle, true);
    expect(plainBundle.interactive).toBeUndefined();

    const noBundle = emptyOptions();
    honourBundleChat(noBundle, undefined, true);
    expect(noBundle.interactive).toBeUndefined();
  });
});

describe('a bundle that recorded session and max-tool-rounds', () => {
  it('carries both from pack through open', async () => {
    const { out } = await pack('--session', '--max-tool-rounds', 'unlimited');
    const bundle = openBundle(out);
    try {
      expect(bundle.session).toBe(true);
      expect(bundle.maxToolRounds).toBe('unlimited');
    } finally {
      bundle.dispose();
    }
  });

  it('proposes them into a run, and the caller overrides', () => {
    type Merged = Parameters<typeof mergeBundleOptions>[0];
    const bundle = {
      name: 'demo',
      plugins: [],
      pluginConfig: [],
      session: true,
      maxToolRounds: 'unlimited',
    } as unknown as OpenedBundle;

    // Nothing typed: the bundle's defaults land.
    const bare: Merged = {};
    mergeBundleOptions(bare, bundle);
    expect(bare.session).toBe(true);
    expect(bare.maxToolRounds).toBe('unlimited');

    // A caller's own flags win: a named session, and a numeric ceiling.
    const typed: Merged = { session: 'my-session', maxToolRounds: '25' };
    mergeBundleOptions(typed, bundle);
    expect(typed.session).toBe('my-session');
    expect(typed.maxToolRounds).toBe('25');

    // --no-session (session === false) is a decision, not an absence.
    const optedOut: Merged = { session: false };
    mergeBundleOptions(optedOut, bundle);
    expect(optedOut.session).toBe(false);
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
