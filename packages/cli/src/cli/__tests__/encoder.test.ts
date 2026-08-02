import { afterAll, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginRegistry, type HeddlePlugin, type WireFrame } from '@heddle-run/core';
import { frameLine, resolveEncoder } from '../encoders.js';
import { runCommand } from '../run.js';

const repoRoot = join(import.meta.dirname, '../../../../../');
const AG_UI = join(repoRoot, 'examples/ag-ui/encoder.json');
const FLOW = join(repoRoot, 'examples/ag-ui/flow.json');

const SPAWNS_A_PLUGIN = 30_000;

const workDir = mkdtempSync(join(tmpdir(), 'heddle-cli-encoder-'));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

/** A manifest and an entry point sharing a basename, which is how the loader pairs them. */
function writePlugin(protocol: string, body: string): string {
  const manifest = join(workDir, `${protocol}.json`);
  writeFileSync(
    manifest,
    JSON.stringify({
      name: `${protocol}-plugin`,
      version: '1.0.0',
      capabilities: [],
      components: [
        {
          componentType: 'TestEncoder',
          kind: 'encoder',
          protocol,
          contentType: 'text/event-stream',
        },
      ],
    }),
  );
  writeFileSync(join(workDir, `${protocol}.mjs`), `serve({ TestEncoder: ${body} });\n`);
  return manifest;
}

function encoderPlugin(protocol: string): HeddlePlugin {
  return {
    name: 'ag-ui-plugin',
    version: '1.0.0',
    encoders: [
      {
        componentType: 'AgUiEncoder',
        protocol,
        contentType: 'text/event-stream',
        createEncoder: () => ({ encode: () => [], finish: () => [] }),
      },
    ],
  };
}

interface Captured {
  stdout: string;
  stderr: string;
}

async function run(...args: string[]): Promise<Captured> {
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
  ];

  try {
    await runCommand.parseAsync(args, { from: 'user' });
  } finally {
    for (const spy of spies) spy.mockRestore();
  }

  return { stdout, stderr };
}

function parseFrames(stdout: string): WireFrame[] {
  return stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as WireFrame);
}

describe('choosing what renders a run', () => {
  it("gives heddle's own frames for heddle's own name", () => {
    const encoder = resolveEncoder('heddle', PluginRegistry.empty());

    expect(encoder('run-1').encode({ type: 'flow_start' })).toEqual([
      { event: 'flow_start', data: { type: 'flow_start' } },
    ]);
  });

  it('reaches a plugin by the protocol it claimed, not its component type', () => {
    const plugins = PluginRegistry.fromPlugins([encoderPlugin('ag-ui')]);

    expect(() => resolveEncoder('ag-ui', plugins)).not.toThrow();
    expect(() => resolveEncoder('AgUiEncoder', plugins)).toThrow(
      /no encoder for protocol/,
    );
  });

  it('names what is available, and where the missing one would come from', () => {
    const plugins = PluginRegistry.fromPlugins([encoderPlugin('ag-ui')]);

    expect(() => resolveEncoder('nope', plugins)).toThrow(
      /Available: heddle, ag-ui\..*--plugin/s,
    );
  });

  it('offers only heddle when no plugin was loaded, so the list is never empty', () => {
    expect(() => resolveEncoder('ag-ui', PluginRegistry.empty())).toThrow(
      /Available: heddle\./,
    );
  });
});

describe('a frame on stdout', () => {
  it("keeps a name heddle's own frames carry", () => {
    expect(frameLine({ event: 'flow_start', data: { type: 'flow_start' } })).toBe(
      '{"event":"flow_start","data":{"type":"flow_start"}}\n',
    );
  });

  it('stays nameless for a protocol that puts its type inside the payload', () => {
    expect(frameLine({ data: { type: 'RUN_STARTED' } })).toBe(
      '{"data":{"type":"RUN_STARTED"}}\n',
    );
  });
});

describe('--protocol with --interactive', () => {
  it('is refused, naming what each of the two owns', async () => {
    await expect(
      run(FLOW, '--interactive', '--protocol', 'ag-ui'),
    ).rejects.toThrow(/--protocol and --interactive cannot be combined/);
  });

  it('is refused before the flow is read, so a missing file is not blamed', async () => {
    await expect(
      run('does-not-exist.json', '-i', '--protocol', 'ag-ui'),
    ).rejects.toThrow(/--protocol and --interactive cannot be combined/);
  });

  it('points at the flag that does compose with an encoder', async () => {
    await expect(run(FLOW, '-i', '--protocol', 'ag-ui')).rejects.toThrow(
      /--session, which composes with --protocol/,
    );
  });
});

describe('a run rendered by the shipped ag-ui encoder', () => {
  it(
    'writes its frames as JSON Lines, every one of them nameless',
    async () => {
      const { stdout } = await run(
        FLOW,
        '--plugin',
        AG_UI,
        '--protocol',
        'ag-ui',
        '--input',
        '{"query":"hello"}',
      );

      const frames = parseFrames(stdout);
      expect(frames.every((frame) => frame.event === undefined)).toBe(true);
      expect(frames.map((frame) => (frame.data as { type: string }).type)).toEqual([
        'RUN_STARTED',
        'STEP_STARTED',
        'STEP_FINISHED',
        'STATE_SNAPSHOT',
        'STEP_STARTED',
        'STEP_FINISHED',
        'STATE_SNAPSHOT',
        'RUN_FINISHED',
      ]);
      expect(frames[3].data).toEqual({
        type: 'STATE_SNAPSHOT',
        snapshot: { query: 'hello' },
      });
    },
    SPAWNS_A_PLUGIN,
  );

  it(
    'leaves stdout parseable, with no final state appended to the frames',
    async () => {
      const { stdout } = await run(
        FLOW,
        '--plugin',
        AG_UI,
        '--protocol',
        'ag-ui',
        '--input',
        '{"query":"hello"}',
      );

      expect(() => parseFrames(stdout)).not.toThrow();
      expect(stdout).not.toContain('"query": "hello"');
    },
    SPAWNS_A_PLUGIN,
  );
});

describe('an encoder that throws mid-run', () => {
  it(
    'reports its own failure, not the abort that failure caused',
    async () => {
      const manifest = writePlugin(
        'broken',
        `{
  encode: () => { throw new Error('this encoder cannot count'); },
  finish: () => [],
}`,
      );

      await expect(
        run(FLOW, '--plugin', manifest, '--protocol', 'broken'),
      ).rejects.toThrow(/this encoder cannot count/);
    },
    SPAWNS_A_PLUGIN,
  );
});

describe("heddle's own protocol, which needs no plugin at all", () => {
  it('names each frame after the event, so the two shapes stay distinct', async () => {
    const { stdout } = await run(
      FLOW,
      '--protocol',
      'heddle',
      '--input',
      '{"query":"hello"}',
    );

    expect(parseFrames(stdout).map((frame) => frame.event)).toEqual([
      'flow_start',
      'node_start',
      'node_complete',
      'node_start',
      'node_complete',
      'flow_complete',
    ]);
  });
});

describe('a run that selects nothing', () => {
  it('is unchanged: the final state on stdout, and no frames', async () => {
    const { stdout } = await run(FLOW, '--input', '{"query":"hello"}');

    expect(JSON.parse(stdout)).toEqual({ query: 'hello' });
  });
});
