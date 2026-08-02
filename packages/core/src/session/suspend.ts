import { RunError } from '../errors.js';
import type { State } from '../state/state.js';
import { RESUME_KEY } from './reserved.js';
import type { Suspension } from './types.js';

/**
 * A run stopped on a human, thrown so it unwinds to the runner.
 *
 * An error rather than a return value, and that is the whole reason this works
 * at a seam buried inside a node. `toolCall.before` is consulted several frames
 * deep in an agent's tool loop, and every frame between it and `Runner.walk`
 * returns something of its own — a message, a verdict, a state. Threading "and
 * also, stop" through all of them would mean changing each of those types for a
 * case none of them has anything to say about.
 *
 * It is not a failure, and the callers that catch it must not report it as one.
 * A run that suspended did what it was told.
 */
export class RunSuspended extends RunError {
  constructor(readonly suspension: Suspension) {
    super(
      `"${suspension.by}" suspended the run at "${suspension.node}" and is ` +
        `waiting on a human. Nothing failed: the run is checkpointed, and ` +
        `resuming it with an answer continues from here.`,
    );
    this.name = 'RunSuspended';
  }
}

export function isSuspended(err: unknown): err is RunSuspended {
  return err instanceof RunSuspended;
}

/**
 * What a resumed executor is handed back, plus the answer it was waiting for.
 *
 * `bookmark` is opaque to everything except the executor that wrote it. The
 * runner carries it and never reads it, which is what keeps re-entering a node
 * from requiring the runner to understand the inside of one.
 */
export interface ResumePayload {
  /** The node whose bookmark this is. */
  node: string;
  bookmark: Record<string, unknown>;
  /** What the human said. Shape is the middleware's, not heddle's. */
  answer: Record<string, unknown>;
}

/** The inputs a resumed run is started with, carrying the human's answer. */
export function resumeInputs(
  suspension: Suspension,
  answer: Record<string, unknown>,
): Record<string, unknown> {
  return {
    [RESUME_KEY]: {
      node: suspension.node,
      bookmark: suspension.resume,
      answer,
    } satisfies ResumePayload,
  };
}

/**
 * The bookmark this node left, if the one in the state belongs to it.
 *
 * The node check matters: a resumed run re-enters one node and then keeps
 * walking, and the payload stays in the carried state as it goes. Without it
 * the *next* agent along would find a bookmark written by the first and try to
 * restore a conversation it never had.
 */
export function readResume(
  input: State,
  node: string,
): ResumePayload | undefined {
  const raw = input.get(RESUME_KEY);
  if (raw === undefined || raw === null) return undefined;

  const payload = asPayload(raw);
  return payload.node === node ? payload : undefined;
}

function asPayload(raw: unknown): ResumePayload {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RunError(
      `"${RESUME_KEY}" is not an object. It is written by heddle when a run is ` +
        `resumed and read by the node being re-entered — a flow that sets it ` +
        `itself is describing a suspension that never happened.`,
    );
  }

  const { node, bookmark, answer } = raw as Record<string, unknown>;
  if (typeof node !== 'string') {
    throw new RunError(`"${RESUME_KEY}" names no node to resume.`);
  }

  return {
    node,
    bookmark: isObject(bookmark) ? bookmark : {},
    answer: isObject(answer) ? answer : {},
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
