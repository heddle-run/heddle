import { randomUUID } from 'node:crypto';
import { SessionError } from '../errors.js';
import type {
  Checkpoint,
  ListOptions,
  SessionRecord,
  SessionSummary,
  Turn,
} from './types.js';

/**
 * Where a conversation and an unfinished run are kept.
 *
 * Seven methods, and three decisions worth stating because a plugin author
 * implementing this will meet all three.
 *
 * **`create` exists, and `append` creates too.** The redundancy is load-bearing.
 * On the CLI a session begins with something to say, so the first append makes
 * it — asking for a separate insert there would be ceremony. On a server it
 * begins with an *identifier*: `POST /v1/sessions` mints one and hands it back
 * before any run has named it, and a session that did not exist until its first
 * turn would make a caller's second request a 404 for a conversation it was
 * just given the name of.
 *
 * **`append` takes the version it expects and returns the new one.** Two
 * writers on one session stops being hypothetical the moment sessions are
 * served over HTTP. A lock is something a networked store would have to invent;
 * a compare-and-swap is something it already has. A mismatch throws
 * {@link SessionConflictError}.
 *
 * **`writeCheckpoint` has no version, and last writer wins.** A checkpoint is
 * one run's own scratch space, and a durable run writes many of them — putting
 * them under the transcript's version would make every checkpoint invalidate
 * the `expect` its own final `append` is holding. What stops two runs sharing a
 * session is {@link isBusy} at the front and the transcript's CAS at the back,
 * not a version on this.
 */
export interface SessionStore {
  /** Bring an empty session into existence. Idempotent. */
  create(id: string, init?: { flow?: string }): Promise<void>;
  read(id: string): Promise<SessionRecord | undefined>;
  append(id: string, turn: Turn, expect: number): Promise<number>;
  readCheckpoint(id: string): Promise<Checkpoint | undefined>;
  /**
   * `null` clears it, which is what a run that finished does.
   *
   * `serialized` is the checkpoint as JSON, when the caller has already paid
   * for the stringify — the sink proves a checkpoint survives JSON before
   * offering it, and a store that writes text can take that instead of
   * serializing the same object twice. A store is free to ignore it.
   */
  writeCheckpoint(
    id: string,
    checkpoint: Checkpoint | null,
    serialized?: string,
  ): Promise<void>;
  list(options?: ListOptions): Promise<SessionSummary[]>;
  delete(id: string): Promise<void>;
}

/**
 * A session id, and the reason it is not a timestamp.
 *
 * The chat sessions this replaced were named `chat-<ISO instant>`, which
 * collides within a millisecond and, more to the point, is guessable. That is
 * survivable in a user's home directory and is not survivable on a server,
 * where the id is the only thing between a caller and somebody else's
 * conversation. See `newSessionId` in the server's own session handling for the
 * rule that ids there are never client-supplied.
 */
export function newSessionId(): string {
  return randomUUID();
}

/**
 * Characters a session id may contain, wherever one becomes a path.
 *
 * Checked rather than escaped. A store keying on an id the caller chose is a
 * store one `../` away from writing outside its root, and an id is written far
 * more often than it is read by a human — so the rule is that it is opaque and
 * boring, not that every consumer remembers to sanitize it.
 */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function assertSessionId(id: string): void {
  if (!SESSION_ID.test(id)) {
    throw new SessionError(
      `"${id}" is not a usable session id. Ids are up to 128 characters of ` +
        `letters, digits, "-" and "_", starting with a letter or digit — they ` +
        `become directory names and database keys, so they carry no path ` +
        `separators and no leading dot.`,
    );
  }
}

/**
 * Whether a session has a run in it that never finished.
 *
 * The guard against two runs sharing one session: a new turn on a busy session
 * is refused, because the previous run is either still going or stopped waiting
 * for a human, and in both cases answering a new question first would append
 * the two turns out of order.
 */
export async function isBusy(
  store: SessionStore,
  id: string,
): Promise<boolean> {
  return (await store.readCheckpoint(id)) !== undefined;
}
