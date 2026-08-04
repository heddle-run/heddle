import { createInterface } from 'node:readline';
import {
  formatRequirements,
  inspectRequirements,
  RequirementError,
  type Requirement,
} from '@heddle-run/core';
import { isTerminal } from './env-prompt.js';

export interface PreflightPromptOptions {
  /** Whether there is somebody at a terminal to answer. See `askForEnvRefs`. */
  interactive?: boolean;
  /** Where the report and the question go. Defaults to stderr. */
  write?: (text: string) => void;
  /** Reads one line; `undefined` is end-of-input. Defaults to {@link readLine}. */
  read?: (question: string) => Promise<string | undefined>;
  /** The environment the checks read. Defaults to this process's. */
  env?: NodeJS.ProcessEnv;
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
 * The asymmetry this rides is the same one that makes the env prompt safe:
 * the bundle says what to *look for*, and only the operator ever *acts*. The
 * tempting version — running the hint after a y/N — inverts that: the command
 * would come from a downloaded file and the operator would contribute one
 * keystroke, which is remote code execution with a speed bump. The hint stays
 * text, heddle only re-checks, and the machine changes only by the operator's
 * own hand in their own shell.
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

  let paused = false;
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
    const answer = await read(
      'The fixes are yours to make — heddle installs nothing. Fix what is ' +
        'missing in another shell, then press enter to check again, or q to ' +
        'stop: ',
    );

    if (answer === undefined || answer.trim().toLowerCase().startsWith('q')) {
      // The report is already on the screen, so the error does not repeat it —
      // a doubled list reads like two different complaints.
      throw new RequirementError(
        `${context} still has ${unmet.length} unmet requirement` +
          `${unmet.length === 1 ? '' : 's'} — listed above. Nothing was run.`,
      );
    }
    paused = true;
  }
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
