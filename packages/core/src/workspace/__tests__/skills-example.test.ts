/**
 * The skills agent `examples/skills-agent/` ships, run as an operator would.
 *
 * The example is the proof of the whole workspace change, so it is loaded from
 * the repository rather than copied here — a second copy is a copy that drifts.
 * Skills are a folder of instructions on somebody's disk, and this is the first
 * arrangement in which heddle can give an agent one.
 *
 * What it pins is the property the pattern exists for: the index is cheap and
 * always in context, and a body costs a tool call the model decided to make. A
 * change that put the bodies in the index would still pass every other test and
 * would have quietly turned skills back into a long prompt.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPlugins } from '../../plugin/loader.js';
import type { PluginRegistry } from '../../plugin/registry.js';
import { SubprocessExecutor } from '../../tool/executor.js';
import { createWorkspaceFactory } from '../factory.js';
import { invokeTool } from '../../tool/invoke.js';
import { composeRegistries, FileRegistry } from '../../tool/registry.js';
import type { ExecutorScope, Registry } from '../../tool/types.js';
import type { WorkspaceTool } from '../types.js';

const repoRoot = join(fileURLToPath(import.meta.url), '../../../../../..');
const example = join(repoRoot, 'examples/skills-agent');

let plugins: PluginRegistry;
let registry: Registry;
let scope: ExecutorScope;

beforeAll(async () => {
  plugins = await loadPlugins([join(example, 'plugin.json')]);
  registry = composeRegistries([
    plugins.toolRegistry(),
    FileRegistry.create(join(example, 'tools')),
  ]);

  const workspaces = createWorkspaceFactory({ mounts: plugins.workspaceMounts() });
  const tools: WorkspaceTool[] = registry.all().map((tool) => ({
    name: tool.name,
    target: tool.impl.kind === 'path' ? tool.impl.path : undefined,
    servedBy: tool.impl.kind === 'plugin' ? tool.impl.plugin : undefined,
  }));

  scope = new SubprocessExecutor({ workspaces, tools }).beginScope('assistant');
}, 20_000);

afterAll(() => {
  scope?.dispose();
  plugins?.dispose();
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

describe('skills as files a plugin ships', () => {
  it('are in the workspace before the first tool runs', async () => {
    const listed = readdirSync(join(scope.workspace, 'skills'));

    expect(listed.sort()).toEqual([
      'date-arithmetic.md',
      'incident-note.md',
      'tabular-summary.md',
    ]);
  });

  it('are an index of names and one line each', async () => {
    const { skills } = await call('list_skills');

    expect(skills).toContain('tabular-summary:');
    expect(skills).toContain('date-arithmetic:');
    expect(skills).toContain('incident-note:');
  });

  /**
   * The load-bearing assertion, and the one this whole arrangement exists for.
   * Names and descriptions are cheap and always in context; a body is a tool
   * call the model decided to make, on a task it decided the skill covers.
   */
  it('carries no body in the index', async () => {
    const { skills } = await call('list_skills');

    for (const file of readdirSync(join(example, 'skills'))) {
      const body = readFileSync(join(example, 'skills', file), 'utf-8')
        .split('\n')
        .slice(2)
        .join('\n')
        .trim();

      expect(body.length).toBeGreaterThan(40);
      expect(skills as string).not.toContain(body.slice(0, 40));
    }
  });

  it('returns one body, by the name the index gave', async () => {
    const { body } = await call('read_skill', { name: 'tabular-summary' });

    expect(body).toContain('Do not add the rows up yourself');
    expect(body).not.toContain('Counting days by hand');
  });

  it('answers a name nothing matches instead of failing the round', async () => {
    const { body } = await call('read_skill', { name: 'tabluar-summary' });

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
      '2026-01-04,travel,412.50\n' +
      '2026-01-09,software,240.00\n' +
      '2026-01-11,meals,90.95\n' +
      '2026-01-18,travel,96.00\n';

    await call('write_file', { path: 'data.csv', content: rows });
    await call('write_file', {
      path: 'summarise.py',
      content:
        'import csv, collections\n' +
        "totals = collections.defaultdict(float)\n" +
        "for row in csv.DictReader(open('data.csv')):\n" +
        "    totals[row['category']] += float(row['amount'])\n" +
        "for name, total in totals.items():\n" +
        "    print('%s %.2f' % (name, total))\n",
    });

    // The three tools share one workspace, which is what makes the procedure a
    // procedure rather than three unrelated calls.
    const run = await call('bash', { command: 'python3 summarise.py' });
    expect(run).toMatchObject({ exit_code: 0, stderr: '' });
    expect(run.stdout).toBe('travel 508.50\nsoftware 240.00\nmeals 90.95\n');
  }, 20_000);

  /**
   * The other half of the workspace change. A skill can say "run summarise" and
   * mean a tool, because every tool is on `$PATH` inside the workspace.
   */
  it('lets a tool reach a peer by the name the model uses for it', async () => {
    const run = await call('bash', {
      command: 'echo \'{"name":"incident-note"}\' | read_skill',
    });

    expect(run.exit_code).toBe(0);
    expect(run.stdout).toContain('WHAT:');
  }, 20_000);
});
