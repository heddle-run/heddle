import { RunError } from '../errors.js';
import type { Message } from '../llm/types.js';
import { CHAT_HISTORY_KEY } from './reserved.js';

/**
 * How a prior conversation enters a run.
 *
 * {@link CHAT_HISTORY_KEY} was a magic string declared twice — once in
 * `agent.ts`, once in the CLI's chat UI — and produced by exactly one writer,
 * so the two could not disagree and nobody had to write down what it was.
 * Sessions give it a second writer and a third (the server), which is what
 * makes it a contract rather than a convention between two files.
 *
 * What it carries: the turns of the conversation *before* this run, oldest
 * first. `AgentExecutor` splices them between its system prompt and the user
 * message it builds from the rest of the input, and keeps the key itself out of
 * that message — a conversation is context, not an argument.
 */

/**
 * One turn of a conversation, as it enters a run.
 *
 * Only `user` and `assistant`, which is narrower than `Message` on purpose. A
 * stored transcript replaying a `system` message would fight the flow's own
 * system prompt, and a `tool` message answers a call that this run never made —
 * the provider matches them by id and would refuse the request.
 */
export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

const HISTORY_ROLES = new Set(['user', 'assistant']);

/**
 * Read a conversation out of whatever was put under {@link CHAT_HISTORY_KEY}.
 *
 * Absent is empty — a first turn has no history and that is not a fault. Present
 * and malformed throws, because the alternative is what this replaced: entries
 * were mapped with a cast, so a bad one reached the provider as a message with
 * an undefined role and came back as an API error naming the model. The flow was
 * fine and the model was fine; the caller's transcript was not, and nothing said
 * so.
 */
export function readHistory(value: unknown): HistoryMessage[] {
  if (value === undefined || value === null) return [];

  if (!Array.isArray(value)) {
    throw new RunError(
      `"${CHAT_HISTORY_KEY}" is ${typeName(value)}, expected an array of ` +
        `{ role, content } turns, oldest first. It is the conversation before ` +
        `this run — a run with none omits the key rather than passing null.`,
    );
  }

  return value.map((entry, index) => readTurn(entry, index));
}

/** The history as the messages an agent puts in front of its own opening turn. */
export function historyMessages(value: unknown): Message[] {
  return readHistory(value).map(({ role, content }) => ({ role, content }));
}

function readTurn(entry: unknown, index: number): HistoryMessage {
  const at = `"${CHAT_HISTORY_KEY}"[${index}]`;

  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new RunError(`${at} is ${typeName(entry)}, expected { role, content }`);
  }

  const { role, content } = entry as Record<string, unknown>;

  if (typeof role !== 'string' || !HISTORY_ROLES.has(role)) {
    throw new RunError(
      `${at} has role ${JSON.stringify(role)}; a history turn is "user" or ` +
        `"assistant". The flow supplies its own system prompt, and a tool ` +
        `message answers a call this run never made.`,
    );
  }
  if (typeof content !== 'string') {
    throw new RunError(
      `${at} has no "content" string. A turn with nothing in it is still ` +
        `written as "".`,
    );
  }

  return { role: role as HistoryMessage['role'], content };
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'an array' : `a ${typeof value}`;
}
