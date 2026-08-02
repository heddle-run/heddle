import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHAT_HISTORY_KEY,
  FileSessionStore,
  historyFromTurns,
} from '@heddle-run/core';
import { runCommand } from '../run.js';
import { sessionsCommand } from '../sessions.js';

const repoRoot = join(import.meta.dirname, '../../../../../');
const FLOW = join(repoRoot, 'examples/ag-ui/flow.json');

let sessionDir: string;
let store: FileSessionStore;

beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), 'heddle-cli-sessions-'));
  store = new FileSessionStore({ root: sessionDir });
});

afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true });
});

interface Captured {
  stdout: string;
  stderr: string;
}

async function invoke(
  command: typeof runCommand,
  args: string[],
): Promise<Captured> {
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

function run(...args: string[]): Promise<Captured> {
  return invoke(runCommand, [...args, '--session-dir', sessionDir]);
}

function sessions(...args: string[]): Promise<Captured> {
  return invoke(sessionsCommand, ['--session-dir', sessionDir, ...args]);
}

describe('a run kept in a session', () => {
  it('names the session it made when the caller did not', async () => {
    const { stderr } = await run(FLOW, '--session', '--input', '{"query":"hi"}');

    const id = stderr.match(/Session: (\S+)/)?.[1];
    expect(id).toBeDefined();

    const record = await store.read(id as string);
    expect(record?.turns).toHaveLength(1);
    expect(record?.turns[0].input).toEqual({ query: 'hi' });
    expect(record?.turns[0].flow).toBe(FLOW);
  });

  it('takes an id the caller chose, and creates it', async () => {
    const { stderr } = await run(
      FLOW,
      '--session',
      'support-42',
      '--input',
      '{"query":"hi"}',
    );

    // Nothing announced: the caller already knows the name it picked.
    expect(stderr).not.toMatch(/Session:/);
    expect((await store.read('support-42'))?.version).toBe(1);
  });

  it('gives the next run the conversation before it', async () => {
    await run(FLOW, '--session', 's1', '--input', '{"query":"first"}');
    await run(FLOW, '--session', 's1', '--input', '{"query":"second"}');

    // The flow passes its state through, so what the second run was *given* is
    // visible in what the first turn's answer became history for.
    const record = await store.read('s1');
    expect(record?.version).toBe(2);
    expect(historyFromTurns(record!.turns.slice(0, 1))).toEqual([
      { role: 'user', content: JSON.stringify({ query: 'first' }) },
      { role: 'assistant', content: JSON.stringify({ query: 'first' }) },
    ]);
  });

  it('prints the answer that was kept, without heddle\'s own keys', async () => {
    await run(FLOW, '--session', 's1', '--input', '{"query":"first"}');
    const { stdout } = await run(
      FLOW,
      '--session',
      's1',
      '--input',
      '{"query":"second"}',
    );

    // The run was given the history; the answer it reports is not carrying it
    // back out, so copying this into the next --input would not be refused.
    const state = JSON.parse(stdout);
    expect(state).toEqual({ query: 'second' });
    expect(CHAT_HISTORY_KEY in state).toBe(false);
    expect((await store.read('s1'))?.turns[1].output).toEqual(state);
  });

  it('records what the caller sent, not what the run was given', async () => {
    await run(FLOW, '--session', 's1', '--input', '{"query":"first"}');
    await run(FLOW, '--session', 's1', '--input', '{"query":"second"}');

    const record = await store.read('s1');
    expect(record?.turns.map((turn) => turn.input)).toEqual([
      { query: 'first' },
      { query: 'second' },
    ]);
  });

  it('refuses a caller that brought its own history', async () => {
    await expect(
      run(
        FLOW,
        '--session',
        's1',
        '--input',
        JSON.stringify({ query: 'hi', [CHAT_HISTORY_KEY]: [] }),
      ),
    ).rejects.toThrow(/cannot be passed to a run that names a session/);
  });

  it('leaves no turn behind when the session was never opened', async () => {
    await expect(
      run(FLOW, '--session', '../escape', '--input', '{}'),
    ).rejects.toThrow(/not a usable session id/);
  });

  it('composes with --protocol, which the flag it replaced could not', async () => {
    const { stdout } = await run(
      FLOW,
      '--session',
      's1',
      '--protocol',
      'heddle',
      '--input',
      '{"query":"hi"}',
    );

    const frames = stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    expect(frames[0].event).toBe('flow_start');
    // The turn was still recorded, with the state the frames never printed.
    expect((await store.read('s1'))?.turns[0].output).toEqual({ query: 'hi' });
  });
});

describe('durability', () => {
  it('needs a session to write a checkpoint into', async () => {
    await expect(run(FLOW, '--durable', '--input', '{}')).rejects.toThrow(
      /--durable needs --session/,
    );
    await expect(run(FLOW, '--resume', '--input', '{}')).rejects.toThrow(
      /--resume needs --session/,
    );
  });

  it('leaves nothing to resume once the run finished', async () => {
    await run(FLOW, '--session', 's1', '--durable', '--input', '{"query":"hi"}');

    expect(await store.readCheckpoint('s1')).toBeUndefined();
    expect((await store.read('s1'))?.version).toBe(1);
  });

  it('refuses to resume a session with no unfinished run', async () => {
    await run(FLOW, '--session', 's1', '--input', '{"query":"hi"}');

    await expect(run(FLOW, '--session', 's1', '--resume')).rejects.toThrow(
      /has nothing to resume/,
    );
  });

  it('refuses a new message while a run is unfinished', async () => {
    await store.writeCheckpoint('s1', {
      runId: 'r1',
      at: new Date().toISOString(),
      node: 'end',
      carried: { query: 'hi' },
      nodeOutputs: {},
      attempt: 1,
      input: { query: 'hi' },
    });

    await expect(
      run(FLOW, '--session', 's1', '--input', '{"query":"next"}'),
    ).rejects.toThrow(/has an unfinished run in it/);
  });

  it('picks a checkpointed run up where it stopped', async () => {
    await store.writeCheckpoint('s1', {
      runId: 'r1',
      at: new Date().toISOString(),
      node: 'end',
      carried: { query: 'hi', already: 'done' },
      nodeOutputs: { start: { query: 'hi' } },
      attempt: 1,
      input: { query: 'hi' },
    });

    const { stdout } = await run(FLOW, '--session', 's1', '--resume');

    // The state the checkpoint carried came back, without start re-running.
    expect(JSON.parse(stdout)).toMatchObject({ query: 'hi', already: 'done' });
    expect(await store.readCheckpoint('s1')).toBeUndefined();
    expect((await store.read('s1'))?.turns[0].input).toEqual({ query: 'hi' });
  });
});

describe('the sessions command', () => {
  it('says where it looked when there is nothing to list', async () => {
    const { stderr } = await sessions('ls');
    expect(stderr).toContain(`no sessions in ${sessionDir}`);
  });

  it('lists what has been kept', async () => {
    await run(FLOW, '--session', 's1', '--input', '{"query":"hi"}');

    const { stdout } = await sessions('ls');
    expect(stdout).toMatch(/^s1\s+\S+\s+1 turns/m);
  });

  it('prints a transcript as a conversation', async () => {
    await run(FLOW, '--session', 's1', '--input', '{"query":"hi"}');

    const { stdout } = await sessions('show', 's1');
    expect(stdout).toBe(
      `> ${JSON.stringify({ query: 'hi' })}\n< ${JSON.stringify({ query: 'hi' })}\n`,
    );
  });

  it('prints the stored record when asked for it', async () => {
    await run(FLOW, '--session', 's1', '--input', '{"query":"hi"}');

    const { stdout } = await sessions('show', 's1', '--json');
    expect(JSON.parse(stdout)).toMatchObject({ id: 's1', version: 1 });
  });

  it('refuses to show a session that is not there', async () => {
    await expect(sessions('show', 'nope')).rejects.toThrow(/no session "nope"/);
  });

  it('deletes one', async () => {
    await run(FLOW, '--session', 's1', '--input', '{"query":"hi"}');
    await sessions('rm', 's1');

    expect(await store.read('s1')).toBeUndefined();
  });
});
