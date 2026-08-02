import { randomUUID } from 'node:crypto';
import { SessionError } from '../errors.js';
import type { HistoryMessage } from './history.js';
import { CHAT_HISTORY_KEY, withoutReserved } from './reserved.js';
import { assertSessionId, type SessionStore } from './store.js';
import type { Checkpoint, SessionRecord, Turn } from './types.js';

/**
 * One turn of a session, opened and closed around a run.
 *
 * Two functions rather than one that owns the `Runner`, because the two callers
 * need the run itself: the CLI drives an event handler that paints a terminal,
 * and the server hands the events to an encoder. A `runTurn` helper would have
 * had to grow a callback for each of them and would still not have covered the
 * third case, which is a run that suspends and never closes its turn at all.
 *
 * What they do own is the part neither surface should reimplement: reading the
 * conversation, refusing a session that is busy, putting the history where an
 * agent looks for it, and appending the result under the version that was read.
 */

export interface OpenTurnOptions {
  /** Recorded on the turn, and on a new session. */
  flow?: string;
  /** Supplied by a resume, which is continuing a run that already had one. */
  runId?: string;
  /** The record, when the caller already read it — spares the second read. */
  record?: SessionRecord;
}

export interface OpenedTurn {
  runId: string;
  /** The transcript version this turn was opened against. */
  version: number;
  /** The caller's inputs, unchanged — what gets recorded. */
  input: Record<string, unknown>;
  /** The inputs plus the conversation, which is what the run is given. */
  inputs: Record<string, unknown>;
  history: HistoryMessage[];
  flow?: string;
}

export interface TurnOutcome {
  output?: Record<string, unknown>;
  error?: { name: string; message: string };
}

/**
 * Read the conversation and prepare the inputs for the next run in it.
 *
 * Refuses a session with an unfinished run in it. Two turns in flight on one
 * conversation would append out of order, and a session left suspended is
 * waiting for an answer rather than for another question — so both are the same
 * refusal with different advice.
 */
export async function openTurn(
  store: SessionStore,
  id: string,
  input: Record<string, unknown>,
  options: OpenTurnOptions = {},
): Promise<OpenedTurn> {
  assertSessionId(id);
  assertNotReserved(input);

  const checkpoint = await store.readCheckpoint(id);
  if (checkpoint) {
    throw new SessionError(unfinishedMessage(id, Boolean(checkpoint.suspension)));
  }

  const record = options.record ?? (await store.read(id));
  const history = historyFromTurns(record?.turns ?? []);

  return {
    runId: options.runId ?? randomUUID(),
    version: record?.version ?? 0,
    input,
    inputs:
      history.length > 0 ? { ...input, [CHAT_HISTORY_KEY]: history } : input,
    history,
    flow: options.flow ?? record?.flow,
  };
}

export interface ResumedTurn extends OpenedTurn {
  checkpoint: Checkpoint;
}

/**
 * Pick a session's unfinished run back up.
 *
 * The mirror of {@link openTurn}, and the asymmetry says what resuming is. That
 * one refuses a session with a checkpoint; this one requires it. That one reads
 * the conversation to build a history for a new question; this one takes the
 * inputs from the checkpoint, because the question was already asked and the
 * run is halfway through answering it.
 *
 * The version is read fresh rather than taken from the checkpoint: turns may
 * have been appended by nothing since the run stopped — a suspended session
 * refuses new messages — but reading it here means the close is checked against
 * what the store actually holds rather than against what it held an hour ago.
 */
export async function resumeTurn(
  store: SessionStore,
  id: string,
): Promise<ResumedTurn> {
  assertSessionId(id);

  const checkpoint = await store.readCheckpoint(id);
  if (!checkpoint) {
    throw new SessionError(
      `session "${id}" has nothing to resume. A run leaves a checkpoint when ` +
        `it is cut or stopped for a human, and clears it when it finishes — so ` +
        `either this one finished, or it was never durable.`,
    );
  }

  const record = await store.read(id);

  return {
    runId: checkpoint.runId,
    version: record?.version ?? 0,
    input: checkpoint.input,
    // Not the history: the run already has the conversation in the state it
    // carried, and splicing it in again would show the agent the turns twice.
    inputs: checkpoint.input,
    history: [],
    flow: record?.flow,
    checkpoint,
  };
}

/**
 * Record what the run came to, under the version the turn was opened at.
 *
 * The output is stripped of heddle's own keys before it is written. They went
 * *in* — the history this turn was given, the answer that resumed it — and a
 * run whose nodes pass their state through hands them straight back out. Stored
 * as part of the answer, each turn would carry a copy of the conversation
 * before it, and the next turn's history would quote that copy: a transcript
 * that grows with the square of its length, which is the exact cost this format
 * was chosen to avoid.
 */
export async function closeTurn(
  store: SessionStore,
  id: string,
  opened: OpenedTurn,
  outcome: TurnOutcome,
): Promise<number> {
  const turn: Turn = {
    runId: opened.runId,
    at: new Date().toISOString(),
    flow: opened.flow,
    input: opened.input,
    ...outcome,
    ...(outcome.output ? { output: withoutReserved(outcome.output) } : {}),
  };

  return store.append(id, turn, opened.version);
}

/**
 * The conversation so far, as the turns an agent is shown.
 *
 * The user side is `JSON.stringify(input)` because that is exactly what
 * `AgentExecutor` builds its own user message from — a history rendered any
 * other way would show the model a conversation in one shape and then the
 * current turn in another.
 *
 * A failed turn contributes nothing. It has no answer, and a lone user message
 * with no reply after it reads to the model as a question it already ignored
 * once.
 */
export function historyFromTurns(turns: Turn[]): HistoryMessage[] {
  const history: HistoryMessage[] = [];

  for (const turn of turns) {
    if (!turn.output) continue;

    history.push({ role: 'user', content: JSON.stringify(turn.input) });
    history.push({ role: 'assistant', content: answerOf(turn.output) });
  }

  return history;
}

/** What a session's transcript says, for a caller that wants to show it. */
export function transcriptOf(record: SessionRecord): HistoryMessage[] {
  return historyFromTurns(record.turns);
}

/**
 * The answer a turn's output amounts to, as one string.
 *
 * The rendering rule for every surface that shows a conversation — the
 * transcript above and the chat UI both use it, so what is on screen is what
 * the next turn's history will quote.
 */
export function answerOf(output: Record<string, unknown>): string {
  return typeof output.result === 'string'
    ? output.result
    : JSON.stringify(output);
}

/**
 * Refuse a caller that brought its own history to a session.
 *
 * The session *is* the history. A caller passing both is describing two
 * conversations and heddle would have to pick one, so it says which one it
 * would have thrown away instead.
 */
function assertNotReserved(input: Record<string, unknown>): void {
  if (CHAT_HISTORY_KEY in input) {
    throw new SessionError(
      `"${CHAT_HISTORY_KEY}" cannot be passed to a run that names a session. ` +
        `The session is the conversation: heddle reads the transcript and ` +
        `supplies it. Pass the message alone, or drop the session and keep ` +
        `managing the history yourself.`,
    );
  }
}

function unfinishedMessage(id: string, suspended: boolean): string {
  return suspended
    ? `session "${id}" is waiting on an answer. A run in it stopped for a ` +
        `human and left a checkpoint, so the next thing it takes is a resume ` +
        `— not another message.`
    : `session "${id}" has an unfinished run in it. Resume it, or delete the ` +
        `checkpoint if the run it belonged to is gone.`;
}
