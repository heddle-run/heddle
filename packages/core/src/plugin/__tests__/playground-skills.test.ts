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
 * What it pins is the property the example exists to demonstrate. Skills reach
 * the model as two tools over data the request carried, so the index costs
 * three names and three lines of context and a body costs a call the model
 * chose to make. A change that put the bodies in the index, or in the prompt,
 * would still run — and would have stopped being an example of anything.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadRemotePlugin } from '../remote-loader.js';
import { PluginRegistry } from '../registry.js';
import { withRuntime } from '../runtime-source.js';
import { invokeTool } from '../../tool/invoke.js';
import { SubprocessExecutor } from '../../tool/executor.js';
import { FileRegistry } from '../../tool/registry.js';
import { loadFlow } from '../../spec/load.js';
import { collectToolNames } from '../../spec/types.js';
import type { Registry } from '../../tool/types.js';

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
  plugins: Array<{
    name: string;
    manifest: Record<string, unknown>;
    source: string;
  }>;
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

const executor = new SubprocessExecutor();

let scratch: string;
let workspace: string;
let plugins: PluginRegistry;
let files: Registry;
let flowPath: string;
let priorWorkspace: string | undefined;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'heddle-skills-'));

  // The one writable directory the tools are given. On the server the sandbox
  // makes it; here the tools read it out of the environment they inherit, which
  // is the same variable by the same name.
  workspace = join(scratch, 'workspace');
  mkdirSync(workspace);
  priorWorkspace = process.env.HEDDLE_WORKSPACE;
  process.env.HEDDLE_WORKSPACE = workspace;

  const submitted = example.plugins[0];
  const entry = join(scratch, `${submitted.name}.mjs`);
  writeFileSync(entry, withRuntime(submitted.source));

  plugins = PluginRegistry.empty();
  plugins.addRemote(
    loadRemotePlugin(submitted.manifest, entry, { timeout: 20_000 }),
  );

  const toolsDir = join(scratch, 'tools');
  mkdirSync(toolsDir);
  for (const tool of example.tools) {
    const path = join(toolsDir, tool.name);
    writeFileSync(path, `${SHEBANG[tool.interpreter]}\n${tool.source}`);
    chmodSync(path, 0o755);
  }
  files = FileRegistry.create(toolsDir);

  flowPath = join(scratch, 'flow.yaml');
  writeFileSync(flowPath, example.flow);
});

afterAll(() => {
  plugins.dispose();
  if (priorWorkspace === undefined) delete process.env.HEDDLE_WORKSPACE;
  else process.env.HEDDLE_WORKSPACE = priorWorkspace;
  rmSync(scratch, { recursive: true, force: true });
});

async function callSkillTool(
  name: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const tool = plugins.toolRegistry().lookup(name)!;
  const { output } = await invokeTool(undefined, tool, input, undefined);
  return output;
}

async function callFileTool(
  name: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const tool = files.lookup(name)!;
  const { output } = await invokeTool(undefined, tool, input, executor);
  return output;
}

interface Listed {
  name: string;
  description: string;
}

const listed = async (): Promise<Listed[]> =>
  (await callSkillTool('list_skills', {})).skills as Listed[];

describe('the index the model is always carrying', () => {
  it('is names and descriptions, and carries no body', async () => {
    const skills = await listed();

    expect(skills.map((skill) => skill.name)).toEqual([
      'tabular-summary',
      'date-arithmetic',
      'incident-note',
    ]);
    for (const skill of skills) {
      expect(Object.keys(skill).sort()).toEqual(['description', 'name']);
      expect(skill.description.length).toBeGreaterThan(0);
    }

    // The load-bearing assertion. A skill body says what to do; a description
    // says when it applies. The moment a body appears here, every skill is in
    // the conversation from the first round and the example is a long prompt
    // with extra steps.
    const written = JSON.stringify(skills);
    for (const skill of skills) {
      const { body } = await callSkillTool('read_skill', { name: skill.name });
      expect(written).not.toContain(String(body).slice(0, 40));
    }
  });

  it('names only skills read_skill can produce', async () => {
    for (const skill of await listed()) {
      const answer = await callSkillTool('read_skill', { name: skill.name });
      expect(answer.name).toBe(skill.name);
      expect(String(answer.body).length).toBeGreaterThan(100);
    }
  });
});

describe('reading one body', () => {
  it('returns that one and no other', async () => {
    const { body } = await callSkillTool('read_skill', {
      name: 'date-arithmetic',
    });

    expect(body).toContain('timedelta');
    expect(body).not.toContain('csv');
  });

  it('answers a name nothing matches instead of failing the round', async () => {
    const { body } = await callSkillTool('read_skill', { name: 'Spreadsheets' });

    // Not a rejected promise: a failed tool call takes the agent's round with
    // it, and the model that guessed the name is the one reader who could pick
    // a better one. So the answer is a sentence listing what there is.
    expect(body).toContain('there is no skill called');
    expect(body).toContain('tabular-summary');
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
      "for name, total in sorted(totals.items(), key=lambda kv: -kv[1]):\n" +
      "    print('%s %.2f' % (name, total))\n";

    expect(
      await callFileTool('write_file', { path: 'data.csv', content: rows }),
    ).toEqual({ result: 'wrote 143 bytes to data.csv' });
    await callFileTool('write_file', {
      path: 'summarise.py',
      content: script,
    });

    // The three tools share one workspace, which is what makes the procedure a
    // procedure rather than three unrelated calls.
    const run = await callFileTool('bash', { command: 'python3 summarise.py' });
    expect(run.exit_code).toBe(0);
    expect(run.stdout).toBe('travel 508.50\nsoftware 240.00\nmeals 90.95\n');

    const back = await callFileTool('read_file', { path: 'summarise.py' });
    expect(back.content).toBe(script);
  });

  it('refuses a path that leaves the workspace, in either direction', async () => {
    expect(
      await callFileTool('write_file', {
        path: '../escaped.txt',
        content: 'no',
      }),
    ).toEqual({ result: 'refused: path must stay inside the workspace' });

    expect(await callFileTool('read_file', { path: '/etc/hosts' })).toEqual({
      content: 'refused: path must stay inside the workspace',
    });
  });

  it('reports a command that failed rather than failing itself', async () => {
    const run = await callFileTool('bash', {
      command: 'python3 -c "import sys; sys.exit(3)"',
    });
    expect(run.exit_code).toBe(3);
  });
});

describe('the flow that ties the two together', () => {
  it('resolves every tool it names against the plugin or the tools directory', () => {
    const flow = loadFlow(flowPath, plugins);
    const named = collectToolNames(flow);

    expect(named).toContain('list_skills');
    expect(named).toContain('read_skill');
    for (const name of named) {
      expect(
        plugins.toolRegistry().lookup(name) ?? files.lookup(name),
      ).toBeDefined();
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
