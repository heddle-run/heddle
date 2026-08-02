/**
 * The skills contract, asserted once for both workspace sources.
 *
 * `skills-example.test.ts` (files an operator installed with a plugin) and
 * `playground-skills.test.ts` (files a caller sent with a request) exist to
 * pin the same property from two ends — the duplication of *sources* is
 * deliberate, the duplication of assertions was not. What both must hold:
 * the skills are in the workspace before the first tool runs, the index is
 * names and one line each and never a body, and `read_skill` answers a bad
 * name — misspelt or escaping — with a sentence rather than a failure.
 */
import { expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { invokeTool } from '../../../tool/invoke.js';
import type { ExecutorScope, Registry } from '../../../tool/types.js';

export interface SkillsSource {
  scope: ExecutorScope;
  registry: Registry;
  /** The skill names, without their `.md`. */
  names: string[];
  /** Each skill's body, its description header stripped. */
  bodies: string[];
  /** Description lines expected verbatim in the index, when the source has them. */
  descriptions?: string[];
}

export async function assertSkillsContract({
  scope,
  registry,
  names,
  bodies,
  descriptions = [],
}: SkillsSource): Promise<void> {
  const call = async (
    name: string,
    input: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> =>
    (await invokeTool(undefined, registry.lookup(name)!, input, scope.executor))
      .output;

  // The files are in the workspace before the first tool runs.
  expect(readdirSync(join(scope.workspace, 'skills')).sort()).toEqual(
    names.map((name) => `${name}.md`).sort(),
  );

  // The index is names and one line each…
  const index = String((await call('list_skills')).skills);
  for (const name of names) expect(index).toContain(`${name}:`);
  for (const description of descriptions) expect(index).toContain(description);

  // …and carries no body. The load-bearing assertion: names and descriptions
  // are cheap and always in context; a body is a tool call the model decided
  // to make. A change that put the bodies in the index would still pass every
  // other test and would have quietly turned skills back into a long prompt.
  for (const body of bodies) {
    expect(body.length).toBeGreaterThan(40);
    expect(index).not.toContain(body.slice(0, 40));
  }

  // A name nothing matches is answered with what there is, not a failed
  // round: the model that guessed the name is the one reader who could pick
  // a better one.
  const missing = await call('read_skill', { name: 'no-such-skill' });
  expect(missing.body).toContain('there is no skill called');
  expect(missing.body).toContain(names[0]);

  // A name that climbs out of the skills directory is refused the same way.
  const escape = await call('read_skill', { name: '../../etc/passwd' });
  expect(escape.body).toContain('there is no skill called');
}
