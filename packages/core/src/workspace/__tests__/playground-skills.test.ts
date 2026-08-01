/**
 * The skills example the playground ships, materialised and run the way
 * heddle-server materialises and runs it.
 *
 * The example is source in `website/lib/playground.ts` and nothing else reads
 * it, so nothing else would notice it breaking — a visitor pressing Run would.
 * It is loaded from there rather than copied here for the reason
 * `shipped-policies.test.ts` loads its manifest from `examples/`: a second copy
 * is a copy that drifts.
 *
 * What it pins is the property the example exists to demonstrate. The skills
 * are three files the request carried into the workspace, and they reach the
 * model as two tools over that directory — so the index costs three names and
 * three lines of context and a body costs a call the model chose to make. A
 * change that put the bodies in the index, or in the prompt, would still run —
 * and would have stopped being an example of anything.
 *
 * It sits beside `skills-example.test.ts` because the two are the same pattern
 * from the two ends the workspace has: files an operator installed with a
 * plugin, and files a caller sent with a request.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { SubprocessExecutor } from '../../tool/executor.js';
import { FileRegistry } from '../../tool/registry.js';
import { invokeTool } from '../../tool/invoke.js';
import { loadFlow } from '../../spec/load.js';
import { collectToolNames } from '../../spec/types.js';
import { PluginRegistry } from '../../plugin/registry.js';
import { createWorkspaceFactory } from '../factory.js';
import { checkedMount } from '../mount.js';
import type { ExecutorScope, Registry } from '../../tool/types.js';
import type { Mount, WorkspaceFactory, WorkspaceTool } from '../types.js';

/**
 * The shipped example, loaded rather than copied — a copy is a second thing to
 * keep in step, and this test exists because the first one drifts.
 *
 * The specifier is built at run time on purpose. `website` is a separate npm
 * project outside this package's `rootDir`, so a static import puts a file
 * `tsc` will not compile into the program and fails the build with TS6059.
 * Vitest resolves it perfectly well; only the compiler needs to be kept from
 * following it.
 */
const playgroundModule = new URL(
  '../../../../../website/lib/playground.ts',
  import.meta.url,
).href;

interface PlaygroundExample {
  id: string;
  flow: string;
  inputs: string;
  tools: Array<{ name: string; source: string; interpreter: string }>;
  files: Array<{ path: string; content: string }>;
}

const { exampleById } = (await import(playgroundModule)) as {
  exampleById: (id: string) => PlaygroundExample | undefined;
};

const example = exampleById('skills')!;

const SHEBANG: Record<string, string> = {
  sh: '#!/bin/sh',
  bash: '#!/usr/bin/env bash',
  python3: '#!/usr/bin/env python3',
  node: '#!/usr/bin/env node',
};

let scratch: string;
let workspaces: WorkspaceFactory;
let scope: ExecutorScope;
let registry: Registry;
let flowPath: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'heddle-skills-'));

  const toolsDir = join(scratch, 'tools');
  mkdirSync(toolsDir);
  for (const tool of example.tools) {
    const path = join(toolsDir, tool.name);
    writeFileSync(path, `${SHEBANG[tool.interpreter]}\n${tool.source}`);
    chmodSync(path, 0o755);
  }
  registry = FileRegistry.create(toolsDir);

  // What `request-code.ts` does with a submitted `files`: the caller's bytes
  // under the run's own directory, and one read-only mount each. Hand-rolled
  // rather than imported because core cannot depend on the server — the shape
  // is the assertion, and `checkedMount` is the part that has to be shared.
  const filesDir = join(scratch, 'files');
  const mounts: Mount[] = example.files.map((file) => {
    const source = join(filesDir, file.path);
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, file.content);

    return checkedMount({
      source,
      dest: file.path,
      mode: 'ro',
      origin: 'the request\'s "files"',
    });
  });

  workspaces = createWorkspaceFactory().extend(mounts);
  const tools: WorkspaceTool[] = registry.all().map((tool) => ({
    name: tool.name,
    target: tool.impl.kind === 'path' ? tool.impl.path : undefined,
  }));

  scope = new SubprocessExecutor({ workspaces, tools }).beginScope('assistant');

  flowPath = join(scratch, 'flow.yaml');
  writeFileSync(flowPath, example.flow);
});

afterAll(() => {
  scope?.dispose();
  workspaces?.dispose();
  rmSync(scratch, { recursive: true, force: true });
});

async function call(
  name: string,
  input: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const { output } = await invokeTool(
    undefined,
    registry.lookup(name)!,
    input,
    scope.executor,
  );
  return output;
}

const index = async (): Promise<string> =>
  String((await call('list_skills')).skills);

describe('the index the model is always carrying', () => {
  it('is in the workspace before the first tool runs', () => {
    expect(readdirSync(join(scope.workspace, 'skills')).sort()).toEqual([
      'date-arithmetic.md',
      'incident-note.md',
      'tabular-summary.md',
    ]);
  });

  it('is names and first lines, and carries no body', async () => {
    const listed = await index();

    for (const file of example.files) {
      const [description, ...rest] = file.content.split('\n');
      expect(listed).toContain(description);

      // The load-bearing assertion. A skill body says what to do; a first line
      // says when it applies. The moment a body appears here, every skill is in
      // the conversation from the first round and the example is a long prompt
      // with extra steps.
      const body = rest.join('\n').trim();
      expect(body.length).toBeGreaterThan(40);
      expect(listed).not.toContain(body.slice(0, 40));
    }
  });

  it('names only skills read_skill can produce', async () => {
    const named = (await index())
      .split('\n')
      .map((line) => line.split(':')[0]);

    expect(named.sort()).toEqual([
      'date-arithmetic',
      'incident-note',
      'tabular-summary',
    ]);
    for (const name of named) {
      const answer = await call('read_skill', { name });
      expect(String(answer.body).length).toBeGreaterThan(100);
    }
  });
});

describe('reading one body', () => {
  it('returns that one and no other', async () => {
    const { body } = await call('read_skill', { name: 'date-arithmetic' });

    expect(body).toContain('timedelta');
    expect(body).not.toContain('csv');
  });

  it('answers a name nothing matches instead of failing the round', async () => {
    const { body } = await call('read_skill', { name: 'Spreadsheets' });

    // Not a rejected promise: a failed tool call takes the agent's round with
    // it, and the model that guessed the name is the one reader who could pick
    // a better one. So the answer is a sentence listing what there is.
    expect(body).toContain('there is no skill called');
    expect(body).toContain('tabular-summary');
  });

  it('refuses a name that climbs out of the skills directory', async () => {
    const { body } = await call('read_skill', { name: '../../etc/passwd' });

    expect(body).toContain('there is no skill called');
  });
});

describe('carrying out what a skill says', () => {
  it('writes the data and the script, runs it, and gets the arithmetic right', async () => {
    const rows =
      'date,category,amount\n' +
      '2026-03-02,travel,412.50\n' +
      '2026-03-04,meals,38.20\n' +
      '2026-03-09,travel,96.00\n' +
      '2026-03-11,software,240.00\n' +
      '2026-03-18,meals,52.75\n';

    const script =
      'import csv, collections\n' +
      'totals = collections.defaultdict(float)\n' +
      "with open('data.csv') as handle:\n" +
      '    for row in csv.DictReader(handle):\n' +
      "        totals[row['category']] += float(row['amount'])\n" +
      'for name, total in sorted(totals.items(), key=lambda kv: -kv[1]):\n' +
      "    print('%s %.2f' % (name, total))\n";

    expect(await call('write_file', { path: 'data.csv', content: rows })).toEqual({
      result: 'wrote 143 bytes to data.csv',
    });
    await call('write_file', { path: 'summarise.py', content: script });

    // The five tools share one workspace, which is what makes the procedure a
    // procedure rather than five unrelated calls — and what puts the skills
    // themselves within reach of the two that read them.
    // Asserted whole rather than field by field, so a failure shows what the
    // command actually said. `exit_code` alone tells you it went wrong and
    // takes the reason away.
    const run = await call('bash', { command: 'python3 summarise.py' });
    expect(run).toEqual({
      stdout: 'travel 508.50\nsoftware 240.00\nmeals 90.95\n',
      stderr: '',
      exit_code: 0,
    });

    const back = await call('read_file', { path: 'summarise.py' });
    expect(back.content).toBe(script);
    // Four python processes, three of them spawning more. Comfortably inside a
    // second on an idle machine and past vitest's 5s default when the rest of
    // the suite is running beside it, which made this the one flaky test in the
    // repo. The budget is the machine's, not the code's.
  }, 20_000);

  it('refuses a path that leaves the workspace, in either direction', async () => {
    expect(
      await call('write_file', { path: '../escaped.txt', content: 'no' }),
    ).toEqual({ result: 'refused: path must stay inside the workspace' });

    expect(await call('read_file', { path: '/etc/hosts' })).toEqual({
      content: 'refused: path must stay inside the workspace',
    });
  });

  it('reports a command that failed rather than failing itself', async () => {
    const run = await call('bash', {
      command: 'python3 -c "import sys; sys.exit(3)"',
    });
    expect(run.exit_code).toBe(3);
  });
});

describe('the flow that ties the two together', () => {
  it('resolves every tool it names against the submitted tools', () => {
    const flow = loadFlow(flowPath, PluginRegistry.empty());
    const named = collectToolNames(flow);

    expect(named).toContain('list_skills');
    expect(named).toContain('read_skill');
    for (const name of named) {
      expect(registry.lookup(name)).toBeDefined();
    }
  });

  it('tells the agent the skills are there and to look first', () => {
    // The contract in its entirety. A model not told to call list_skills will
    // not call it, and three skills nothing reads are three strings in a
    // request body.
    expect(example.flow).toMatch(/Call list_skills first, on every task/);
    expect(example.flow).toMatch(/read that skill and follow it exactly/);
  });
});
