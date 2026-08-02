import { SessionError } from '../errors.js';
import type { CheckpointSink, RunPosition } from '../runner/options.js';
import type { SessionStore } from './store.js';
import type { Checkpoint, Suspension } from './types.js';

export interface CheckpointOptions {
  store: SessionStore;
  sessionId: string;
  runId: string;
  /** The inputs the run started with, so a resumed run reports the same turn. */
  input: Record<string, unknown>;
}

/**
 * A place for the runner to put its position: this session's checkpoint slot.
 *
 * The adapter between two things that deliberately do not know about each
 * other. `Runner` knows where it got to; `SessionStore` knows where
 * conversations live. Neither has to learn the other's vocabulary for a run to
 * become resumable.
 */
export function checkpointSink(options: CheckpointOptions): CheckpointSink {
  const { store, sessionId, runId, input } = options;

  return {
    async save(position: RunPosition): Promise<void> {
      const checkpoint = checkpointFrom(position, runId, input);
      await store.writeCheckpoint(
        sessionId,
        checkpoint,
        assertStorable(checkpoint, sessionId),
      );
    },

    async suspend(position, suspension): Promise<void> {
      const checkpoint = checkpointFrom(position, runId, input, suspension);
      await store.writeCheckpoint(
        sessionId,
        checkpoint,
        assertStorable(checkpoint, sessionId),
      );
    },

    async clear(): Promise<void> {
      await store.writeCheckpoint(sessionId, null);
    },
  };
}

export function checkpointFrom(
  position: RunPosition,
  runId: string,
  input: Record<string, unknown>,
  suspension?: Suspension,
): Checkpoint {
  return {
    runId,
    at: new Date().toISOString(),
    node: position.node,
    carried: position.carried,
    nodeOutputs: position.nodeOutputs,
    attempt: position.attempt,
    input,
    ...(suspension ? { suspension } : {}),
  };
}

/** The position a checkpoint resumes the runner at. */
export function positionOf(checkpoint: Checkpoint): RunPosition {
  return {
    node: checkpoint.node,
    carried: checkpoint.carried,
    nodeOutputs: checkpoint.nodeOutputs,
    attempt: checkpoint.attempt,
  };
}

/**
 * Refuse a checkpoint that could be written and never read back.
 *
 * A run's state is whatever its nodes produced, and a tool or a plugin is free
 * to put something in it that does not survive `JSON.stringify` — a cycle, a
 * BigInt, a class that serializes to nothing. The store would take it and the
 * failure would surface on resume, as a checkpoint that will not parse, hours
 * later and nowhere near the node that caused it. Checked here, where the node
 * that just ran is still the obvious suspect — and the proof is the JSON
 * itself, which is handed to the store so it is not paid for twice.
 */
function assertStorable(checkpoint: Checkpoint, sessionId: string): string {
  try {
    return JSON.stringify(checkpoint);
  } catch (err) {
    throw new SessionError(
      `the run in session "${sessionId}" cannot be checkpointed at ` +
        `"${checkpoint.node}": its state does not survive JSON. A durable run ` +
        `is written down between nodes, so everything a node produces has to ` +
        `be plain values — no cycles, no BigInt, no class instances.`,
      { cause: err },
    );
  }
}
