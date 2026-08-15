/**
 * Files a request carries into its own workspaces, end to end.
 *
 * The other half of submitted code, and the half that is not code: a submitted
 * tool is a program the run calls, and a submitted file is content it reads.
 * What makes the pair worth having is that they meet in the workspace — the
 * tool globs a directory it did not ship, the request filled it, and neither
 * one had to be installed on this server.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createServer } from '../server.js';

/** Reads the workspace the run gave it, not a path of its own choosing. */
const LIST_SKILLS = `import json, os, pathlib, sys

json.load(sys.stdin)

root = pathlib.Path(os.environ.get("HEDDLE_WORKSPACE") or os.getcwd()) / "skills"
index = "\\n".join(
    "%s: %s" % (path.stem, path.read_text().splitlines()[0])
    for path in sorted(root.glob("*.md"))
)

json.dump({"index": index or "there are no skills here"}, sys.stdout)
`;

const TIDY = 'Tidying a CSV\n\nRound to two decimals and keep the header row.\n';
const DATES = 'Date arithmetic\n\nCount days with timedelta, never by hand.\n';

function skillsFlow(): Record<string, unknown> {
  return {
    weave: 1,
    name: 'skills-flow',
    inputs: { task: 'string' },
    tools: {
      list_skills: {
        description: 'every skill and its first line',
        outputs: { index: 'string' },
      },
    },
    steps: [{ name: 'list', tool: 'list_skills', with: {} }],
  };
}

const listSkills = () => ({
  name: 'list_skills',
  source: LIST_SKILLS,
  interpreter: 'python3',
});

const skillFiles = () => [
  { path: 'skills/tabular-summary.md', content: TIDY },
  { path: 'skills/date-arithmetic.md', content: DATES },
];

let server: Server;
let base: string;
let workDir: string;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'heddle-submitted-files-test-'));

  server = createServer({
    allowRequestCode: true,
    workDir,
    maxRequestFiles: 3,
    log: () => {},
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function post(path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function run(files: unknown, tools = [listSkills()]) {
  const res = await post('/v1/runs', {
    flow: skillsFlow(),
    inputs: { task: 'anything' },
    tools,
    files,
  });
  return { status: res.status, body: (await res.json()) as Record<string, never> };
}

describe('a tool reading what the request sent', () => {
  it('finds it in the workspace, under the path the request named', async () => {
    const { status, body } = await run(skillFiles());

    expect(status).toBe(200);
    expect(body).toMatchObject({
      flow: 'skills-flow',
      state: {
        index: 'date-arithmetic: Date arithmetic\ntabular-summary: Tidying a CSV',
      },
    });
  });

  it('gives the next run a workspace without them', async () => {
    // The property the whole arrangement rests on: these are one caller's
    // bytes, layered onto the server's own factory for one run and disposed
    // with it. A file that outlived its request would be in the working
    // directory of every later caller's nodes.
    const { body } = await run([]);
    expect(body).toMatchObject({ state: { index: 'there are no skills here' } });
  });

  it('leaves nothing behind on disk once the run is over', async () => {
    const before = readdirSync(workDir);
    await run(skillFiles());
    expect(readdirSync(workDir)).toEqual(before);
  });
});

describe('a path the workspace will not take', () => {
  async function refused(path: string): Promise<string> {
    const { status, body } = await run([{ path, content: 'x' }]);
    expect(status).toBe(400);
    return (body as unknown as { error: { message: string } }).error.message;
  }

  it('one that climbs out', async () => {
    expect(await refused('../escaped.md')).toMatch(/climbs out of the workspace/);
  });

  it('an absolute one', async () => {
    expect(await refused('/etc/hosts')).toMatch(/is an absolute path/);
  });

  it('one under the reserved directory, which holds the tools', async () => {
    expect(await refused('.heddle/bin/list_skills')).toMatch(/reserves/);
  });

  it('two files that would land on the same path', async () => {
    const { status, body } = await run([
      { path: 'skills/a.md', content: 'one' },
      { path: 'skills/a.md', content: 'two' },
    ]);
    expect(status).toBe(400);
    expect((body as unknown as { error: { message: string } }).error.message).toMatch(
      /duplicate file path/,
    );
  });

  it('a file with no content, which would be a host path by another name', async () => {
    const { status, body } = await run([{ path: 'skills/a.md' }]);
    expect(status).toBe(400);
    expect((body as unknown as { error: { message: string } }).error.message).toMatch(
      /carries its own bytes/,
    );
  });
});

describe('what one request may spend', () => {
  it('refuses more files than the server accepts', async () => {
    const many = Array.from({ length: 4 }, (_, i) => ({
      path: `skills/skill-${i}.md`,
      content: 'x',
    }));

    const { status, body } = await run(many);
    expect(status).toBe(400);
    expect((body as unknown as { error: { message: string } }).error.message).toMatch(
      /at most 3 files/,
    );
  });

  it('counts their bytes against the same budget as the code', async () => {
    // One budget over tools, plugins and files, because to the caller they are
    // one thing: bytes this request asked the server to hold.
    const { status, body } = await run([
      { path: 'skills/huge.md', content: 'x'.repeat(300 * 1024) },
    ]);

    expect(status).toBe(400);
    expect((body as unknown as { error: { type: string } }).error.type).toBe(
      'PayloadTooLarge',
    );
  });
});

describe('a server that does not take request code', () => {
  it('refuses files by name, rather than ignoring them', async () => {
    const closed = createServer({ log: () => {} });
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const address = closed.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ flow: skillsFlow(), files: skillFiles() }),
      });

      expect(res.status).toBe(400);
      // Named, for the reason the other two fields are: a caller whose files
      // were silently dropped would see a tool find an empty directory and
      // have no way to learn why.
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain('"files" is not accepted');
      expect(body.error.message).toContain('--allow-request-code');
    } finally {
      await new Promise<void>((resolve) => closed.close(() => resolve()));
    }
  });
});
