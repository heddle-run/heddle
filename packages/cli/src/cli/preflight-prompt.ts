import { createInterface } from 'node:readline';
import {
  formatRequirements,
  inspectRequirements,
  RequirementError,
  type Requirement,
} from '@heddle-run/core';
import { isTerminal } from './env-prompt.js';
import {
  describeRecipe,
  executeRecipe,
  installRecipes,
  type InstallRecipe,
} from './install-recipes.js';

export interface PreflightPromptOptions {
  /** Whether there is somebody at a terminal to answer. See `askForEnvRefs`. */
  interactive?: boolean;
  /** Where the report and the question go. Defaults to stderr. */
  write?: (text: string) => void;
  /** Reads one line; `undefined` is end-of-input. Defaults to {@link readLine}. */
  read?: (question: string) => Promise<string | undefined>;
  /** The environment the checks read. Defaults to this process's. */
  env?: NodeJS.ProcessEnv;
  /** Runs one accepted recipe. A test seam; defaults to {@link executeRecipe}. */
  execute?: (recipe: InstallRecipe) => Promise<void>;
}

/**
 * Hold the run at its unmet requirements until they hold, or the caller stops.
 *
 * The interactive counterpart to core's `assertRequirements`, shaped like the
 * env prompt beside it: on a terminal a preflight failure becomes a pause
 * rather than an exit, so "brew install whisper-cpp" is something you do in
 * the next shell over and then press enter, not a reason to lose the command
 * line you had built up. Off a terminal nothing is asked and the refusal is
 * exactly what it always was, report and all — CI sees no pause.
 *
 * When heddle knows the fix itself — a recipe from its own curated table, see
 * `install-recipes.ts` — it offers to run it, exact commands on screen, and
 * acts only on a typed yes. What keeps that offer from being remote code
 * execution with a speed bump is whose words run: every command, URL and
 * destination comes from the table versioned with this CLI, and a downloaded
 * bundle can only *select* an entry, never author one. The hint a bundle
 * carries stays what it always was — text shown to a human, executed never.
 * For everything the table does not cover, the machine still changes only by
 * the operator's own hand in their own shell.
 */
export async function waitForRequirements(
  requires: Requirement[],
  context: string,
  options: PreflightPromptOptions = {},
): Promise<void> {
  if (requires.length === 0) return;

  const env = options.env ?? process.env;
  const interactive = options.interactive ?? isTerminal();
  const write = options.write ?? ((text: string) => process.stderr.write(text));
  const read = options.read ?? readLine;
  const execute = options.execute ?? executeRecipe;

  let paused = false;
  let declined = false;
  for (;;) {
    const checks = inspectRequirements(requires, env);
    const unmet = checks.filter((check) => check.reason !== undefined);

    if (unmet.length === 0) {
      // Only after a pause: a run whose requirements simply held gets no
      // banner for it, same as before this prompt existed.
      if (paused) write('\nEverything holds now — starting.\n\n');
      return;
    }

    const report = formatRequirements(context, checks);
    if (!interactive) throw new RequirementError(report);

    write(`\n${report}\n`);
    paused = true;

    // The offer comes once. Declining it means the operator wants their own
    // hands on the machine, and asking again every re-check would be nagging.
    const recipes = declined ? [] : installRecipes(unmet, env);
    if (recipes.length > 0) {
      const count = recipes.length === 1 ? 'one of these' : `${recipes.length} of these`;
      write(
        `heddle can fix ${count} itself, by running exactly:\n\n` +
          recipes.map((recipe) => `    ${describeRecipe(recipe)}\n`).join('') +
          '\n',
      );
      const consent = await read('Run that now? [y/N] ');
      if (consent === undefined) {
        throw new RequirementError(
          `${context} still has ${unmet.length} unmet requirement` +
            `${unmet.length === 1 ? '' : 's'} — listed above. Nothing was run.`,
        );
      }
      if (/^y(es)?$/i.test(consent.trim())) {
        if (await runRecipes(recipes, write, execute)) continue;
      } else {
        declined = true;
      }
      // A failed recipe falls through to the manual pause, list still known.
    }

    const preamble =
      recipes.length > 0 || declined
        ? 'The rest of the fixes are yours to make.'
        : 'The fixes are yours to make — heddle has no recipe for these.';
    const answer = await read(
      `${preamble} Fix what is missing in another shell, then press enter ` +
        'to check again, or q to stop: ',
    );

    if (answer === undefined || answer.trim().toLowerCase().startsWith('q')) {
      // The report is already on the screen, so the error does not repeat it —
      // a doubled list reads like two different complaints.
      throw new RequirementError(
        `${context} still has ${unmet.length} unmet requirement` +
          `${unmet.length === 1 ? '' : 's'} — listed above. Nothing was run.`,
      );
    }
  }
}

/**
 * Run the accepted recipes in order; true when every one landed. A failure
 * stops the batch — the recipes after it may depend on the broken one, and
 * the operator should read the error before anything else changes — but it is
 * reported, not thrown: the pause loop already knows how to hold a run at
 * whatever is still missing.
 */
async function runRecipes(
  recipes: InstallRecipe[],
  write: (text: string) => void,
  execute: (recipe: InstallRecipe) => Promise<void>,
): Promise<boolean> {
  for (const recipe of recipes) {
    write(`\n→ ${describeRecipe(recipe)}\n`);
    try {
      await execute(recipe);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      write(`\nThat did not land: ${reason}\n\n`);
      return false;
    }
  }
  write('\n');
  return true;
}

/**
 * One visible line. Plain `readline` rather than the raw-mode reader next
 * door, because nothing typed here is a secret — the only answers are enter
 * and q — and readline's own line editing is fine for that.
 */
function readLine(question: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    let settled = false;

    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(value);
    };

    // Readline swallows the signal, so the shell's convention is this
    // function's job — the same 130 the hidden reader exits with.
    rl.on('SIGINT', () => {
      rl.close();
      process.exit(130);
    });
    rl.on('close', () => finish(undefined));
    rl.question(question, finish);
  });
}
