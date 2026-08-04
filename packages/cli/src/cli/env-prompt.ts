import { collectEnvRefs, type ParsedFlow } from '@heddle-run/core';

/** Ctrl-C. In raw mode the terminal hands it over instead of raising SIGINT. */
const ETX = '\u0003';
/** Ctrl-D, which ends a line the same way Enter does. */
const EOT = '\u0004';
const BACKSPACE = new Set(['\u007f', '\b']);

export interface EnvPromptOptions {
  /**
   * Whether there is somebody at a terminal to answer. Defaults to stdin and
   * stderr both being one: a question written into a redirected stderr is a
   * run that hangs with nothing on screen explaining why.
   */
  interactive?: boolean;
  /** Where the questions go. Defaults to stderr, so stdout stays the answer. */
  write?: (text: string) => void;
  /** Reads one answer without echoing it. Defaults to {@link askHidden}. */
  read?: (question: string) => Promise<string>;
  /** Where the answers land. Defaults to this process's environment. */
  env?: NodeJS.ProcessEnv;
  /**
   * Variables to ask about beyond the ones the flow names — a bundle's
   * declared `env` requirements. `collectEnvRefs` finds what a spec *mentions*,
   * which is not the same set: a bundle may need a key only its tools read,
   * and that one is worth asking for too rather than refusing over.
   */
  also?: string[];
}

/**
 * Ask for the variables this flow names and this environment does not have.
 *
 * Credentials resolve at the first model call, which is the right moment to
 * resolve them and a miserable one to fail at: the run has already picked a
 * session, mounted a workspace and spent a node or two getting there. Asking
 * up front costs nothing when the variables are set — the common case reads
 * `process.env` and returns — and turns the failure into a question while the
 * terminal is still the caller's.
 *
 * It stays a question, never a requirement. An empty answer leaves the
 * variable unset and the run goes ahead: this cannot tell a credential the run
 * needs from one on a branch it never takes, and refusing to start would break
 * flows that work today. Whatever is skipped fails where it always did.
 *
 * Returns the variables that were filled in, for the caller that wants to say so.
 */
export async function askForEnvRefs(
  flow: ParsedFlow,
  options: EnvPromptOptions = {},
): Promise<string[]> {
  const env = options.env ?? process.env;
  const named = new Set([...collectEnvRefs(flow), ...(options.also ?? [])]);
  const missing = [...named].filter((key) => !env[key]);
  if (missing.length === 0) return [];

  const interactive = options.interactive ?? isTerminal();
  if (!interactive) return [];

  const write = options.write ?? ((text: string) => process.stderr.write(text));
  const read = options.read ?? askHidden;

  write(
    `\n${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set, ` +
      `and this flow reads ${missing.length === 1 ? 'it' : 'them'} from the ` +
      `environment.\nAn answer is used for this run only — it is not echoed, ` +
      `and it is not written anywhere. Press enter to leave one unset.\n\n`,
  );

  const filled: string[] = [];
  for (const key of missing) {
    const answer = (await read(`  ${key}: `)).trim();
    if (answer === '') continue;

    env[key] = answer;
    filled.push(key);
  }

  if (filled.length > 0) {
    write(
      `\nExport ${filled.length === 1 ? 'it' : 'them'} in your shell to skip ` +
        `this next time.\n\n`,
    );
  }

  return filled;
}

/**
 * Whether there is somebody at a terminal to answer — the gate every
 * interactive question in this CLI shares, so "when heddle may ask" does not
 * depend on which prompt is asking.
 */
export function isTerminal(): boolean {
  return process.stdin.isTTY === true && process.stderr.isTTY === true;
}

/**
 * One line, read without echoing it.
 *
 * Raw mode rather than `readline`, because what is being typed is a credential
 * and readline's only way not to print it is to reach past its own interface.
 * Raw mode also means every convention the line editor provided is now this
 * function's job, which is why Ctrl-C is handled here: the terminal no longer
 * turns it into a signal, so a caller who changed their mind would otherwise
 * be typing into a prompt they cannot leave.
 */
function askHidden(question: string): Promise<string> {
  const input = process.stdin;
  const output = process.stderr;

  return new Promise((resolve) => {
    const wasRaw = input.isRaw === true;
    let value = '';

    const restore = (): void => {
      input.off('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
    };

    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n' || char === EOT) {
          restore();
          resolve(value);
          return;
        }
        if (char === ETX) {
          restore();
          // The shell's own answer to Ctrl-C, since nothing else will give it:
          // 128 + SIGINT, and no error text for something the caller chose.
          process.exit(130);
        }
        if (BACKSPACE.has(char)) {
          value = value.slice(0, -1);
          continue;
        }
        // The rest of the control range is what a terminal sends for arrow
        // keys and escape sequences. None of it belongs in a credential.
        if (char >= ' ') value += char;
      }
    };

    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    input.on('data', onData);
    output.write(question);
  });
}
