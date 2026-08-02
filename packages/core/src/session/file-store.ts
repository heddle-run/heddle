import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SessionConflictError, SessionError } from '../errors.js';
import { assertSessionId, type SessionStore } from './store.js';
import type {
  Checkpoint,
  ListOptions,
  SessionRecord,
  SessionSummary,
  Turn,
} from './types.js';

const META = 'meta.json';
const TURNS = 'turns.jsonl';
const CHECKPOINT = 'checkpoint.json';
const LOCK = '.lock';

/** How long a lock left by a dead process is honoured before it is broken. */
const STALE_LOCK_MS = 30_000;
const LOCK_POLL_MS = 20;
const LOCK_WAIT_MS = 5_000;

interface Meta {
  id: string;
  flow?: string;
  createdAt: string;
}

export interface FileSessionStoreOptions {
  /** Defaults to `$HEDDLE_SESSION_DIR`, then `~/.heddle/sessions`. */
  root?: string;
}

/**
 * Sessions as a directory each.
 *
 * ```
 * <root>/<id>/meta.json         id, flow, createdAt
 *             turns.jsonl       one turn per line, appended
 *             checkpoint.json   present only while a run is unfinished
 * ```
 *
 * Three things this is not, each of which the format it replaced was.
 *
 * **Not one file.** A checkpoint is a sibling, so writing and clearing one
 * never rewrites the transcript.
 *
 * **Not rewritten per turn.** The old `persist` serialized the whole session on
 * every message, so recording a conversation cost O(n²) bytes. A line is
 * appended here.
 *
 * **Not a JSON blob for the transcript.** JSONL means a half-written turn
 * damages one line rather than the file, and {@link readTurns} skips a trailing
 * partial line instead of failing to parse the conversation.
 *
 * Every whole-file write goes through {@link writeAtomic}: a temp file in the
 * same directory, then a rename. A half-written `checkpoint.json` that a resume
 * then reads is precisely the failure this exists to prevent.
 */
export class FileSessionStore implements SessionStore {
  private readonly root: string;

  constructor(options: FileSessionStoreOptions = {}) {
    this.root = options.root ?? defaultRoot();
  }

  /** Where this store keeps its sessions. Reported by `heddle sessions`. */
  location(): string {
    return this.root;
  }

  async create(id: string, init: { flow?: string } = {}): Promise<void> {
    assertSessionId(id);

    // Idempotent, and deliberately not "refuse if it exists": the caller that
    // wants that is asking whether an id is taken, which `read` answers.
    // Rewriting the meta of a live session would move its `createdAt`.
    if (this.readMeta(id)) return;

    this.writeMeta(id, {
      id,
      flow: init.flow,
      createdAt: new Date().toISOString(),
    });
  }

  async read(id: string): Promise<SessionRecord | undefined> {
    assertSessionId(id);

    const meta = this.readMeta(id);
    if (!meta) return undefined;

    const turns = this.readTurns(id);
    return { ...meta, version: turns.length, turns };
  }

  async append(id: string, turn: Turn, expect: number): Promise<number> {
    assertSessionId(id);

    return this.locked(id, () => {
      const existing = this.readMeta(id);
      const turns = existing ? this.countTurns(id) : 0;

      if (turns !== expect) {
        throw new SessionConflictError(id, expect, turns);
      }
      if (!existing) this.writeMeta(id, newMeta(id, turn));

      appendFileSync(join(this.root, id, TURNS), `${JSON.stringify(turn)}\n`);
      return turns + 1;
    });
  }

  async readCheckpoint(id: string): Promise<Checkpoint | undefined> {
    assertSessionId(id);

    const path = join(this.root, id, CHECKPOINT);
    if (!existsSync(path)) return undefined;

    return parse<Checkpoint>(path, 'checkpoint');
  }

  async writeCheckpoint(
    id: string,
    checkpoint: Checkpoint | null,
  ): Promise<void> {
    assertSessionId(id);

    const path = join(this.root, id, CHECKPOINT);
    if (checkpoint === null) {
      if (existsSync(path)) unlinkSync(path);
      return;
    }

    // A checkpoint can be the first thing written to a session: a durable run
    // reaches its second node long before it has a turn to append.
    if (!this.readMeta(id)) this.writeMeta(id, newMeta(id));
    writeAtomic(path, JSON.stringify(checkpoint));
  }

  async list(options: ListOptions = {}): Promise<SessionSummary[]> {
    if (!existsSync(this.root)) return [];

    const summaries = readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.summarize(entry.name))
      .filter((summary): summary is SessionSummary => summary !== undefined)
      // Newest first: a listing is read by somebody looking for what they were
      // just doing, not by somebody reading it from the beginning.
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

    const start = options.cursor
      ? summaries.findIndex((s) => s.id === options.cursor) + 1
      : 0;

    return options.limit === undefined
      ? summaries.slice(start)
      : summaries.slice(start, start + options.limit);
  }

  async delete(id: string): Promise<void> {
    assertSessionId(id);
    rmSync(join(this.root, id), { recursive: true, force: true });
  }

  private summarize(id: string): SessionSummary | undefined {
    const meta = this.readMeta(id);
    if (!meta) return undefined;

    const turnsPath = join(this.root, id, TURNS);
    const updatedAt = existsSync(turnsPath)
      ? statSync(turnsPath).mtime.toISOString()
      : meta.createdAt;

    return {
      ...meta,
      updatedAt,
      turns: this.countTurns(id),
      unfinished: existsSync(join(this.root, id, CHECKPOINT)),
    };
  }

  private readMeta(id: string): Meta | undefined {
    const path = join(this.root, id, META);
    return existsSync(path) ? parse<Meta>(path, 'session') : undefined;
  }

  private writeMeta(id: string, meta: Meta): void {
    mkdirSync(join(this.root, id), { recursive: true });
    writeAtomic(join(this.root, id, META), JSON.stringify(meta, null, 2));
  }

  private readTurns(id: string): Turn[] {
    const path = join(this.root, id, TURNS);
    if (!existsSync(path)) return [];

    return usableLines(readFileSync(path, 'utf-8')).map((line, index) => {
      try {
        return JSON.parse(line) as Turn;
      } catch (err) {
        throw new SessionError(
          `session "${id}" has an unreadable turn at line ${index + 1} of ` +
            `${TURNS}. The rest of the conversation is intact — the file is ` +
            `one JSON turn per line, so the damaged line can be removed.`,
          { cause: err },
        );
      }
    });
  }

  private countTurns(id: string): number {
    const path = join(this.root, id, TURNS);
    if (!existsSync(path)) return 0;

    return usableLines(readFileSync(path, 'utf-8')).length;
  }

  /**
   * Hold this session's lock for the duration of a read-check-write.
   *
   * The filesystem has no compare-and-swap, so the version check in `append`
   * and the append itself have to be one operation against anything else on
   * this machine. `openSync` with `wx` is the primitive that gives it: it
   * either creates the file or fails, with no window between the two.
   *
   * A lock older than {@link STALE_LOCK_MS} is broken rather than waited on. A
   * process that died mid-append would otherwise wedge that session for good,
   * and the cost of being wrong is two writers on a session — which the version
   * check then catches anyway.
   */
  private locked<T>(id: string, work: () => T): T {
    mkdirSync(join(this.root, id), { recursive: true });
    const path = join(this.root, id, LOCK);

    const acquired = acquire(path);
    try {
      return work();
    } finally {
      if (acquired) {
        try {
          unlinkSync(path);
        } catch {
          // Broken by another process that judged it stale. Nothing to undo:
          // the lock is advisory and the work above is already done.
        }
      }
    }
  }
}

function acquire(path: string): boolean {
  const deadline = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    try {
      closeSync(openSync(path, 'wx'));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (isStale(path)) {
        unlinkSync(path);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new SessionError(
          `waited ${LOCK_WAIT_MS}ms for the lock on ${path}. Another heddle ` +
            `process is writing this session; if none is, remove the file.`,
        );
      }
      sleepBriefly();
    }
  }
}

function isStale(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > STALE_LOCK_MS;
  } catch {
    // Gone between the failed create and this check — somebody released it.
    return false;
  }
}

/**
 * Wait without an event loop turn.
 *
 * `Atomics.wait` rather than a promise, because the whole `locked` body is
 * synchronous: the check and the write have to be one operation with respect to
 * this process too, and awaiting inside it would let a second `append` on the
 * same session interleave between them.
 */
function sleepBriefly(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
}

function writeAtomic(path: string, contents: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, contents);
  renameSync(temporary, path);
}

function parse<T>(path: string, what: string): T {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch (err) {
    throw new SessionError(`unreadable ${what} file at ${path}`, { cause: err });
  }
}

/**
 * The lines of a JSONL file that are whole.
 *
 * A trailing line with no newline after it is a write that did not finish, and
 * dropping it is the point of the format: the conversation before it is intact
 * and readable, which a truncated JSON blob would not be.
 */
function usableLines(contents: string): string[] {
  const lines = contents.split('\n');
  lines.pop();
  return lines.filter((line) => line.trim().length > 0);
}

function newMeta(id: string, turn?: Turn): Meta {
  return {
    id,
    flow: turn?.flow,
    createdAt: turn?.at ?? new Date().toISOString(),
  };
}

function defaultRoot(): string {
  return (
    process.env.HEDDLE_SESSION_DIR ||
    join(homedir() || process.cwd(), '.heddle', 'sessions')
  );
}
