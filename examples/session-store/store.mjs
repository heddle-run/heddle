import { DatabaseSync } from 'node:sqlite';

/**
 * A session store on SQLite, which is the shape a real one has.
 *
 * SQLite rather than Redis or Postgres so this runs with nothing installed —
 * `node:sqlite` ships with Node. What it demonstrates is not the database but
 * the two things every store has to get right:
 *
 * **The compare-and-swap in `append`.** The `expect` a caller passes is the
 * version it read before the run started, and honouring it is what stops two
 * concurrent turns interleaving in one conversation. Here it is a `WHERE
 * turns = ?` on the update, so the check and the write are one statement. A
 * store that read the version, compared it in JavaScript and then wrote would
 * have a window between them, which is the bug this parameter exists to
 * prevent.
 *
 * **A conflict is a result, not a failure.** A store in another process cannot
 * throw across the boundary, so it answers `{ conflict: { version } }` and
 * heddle rebuilds the error on its side. Throwing here would reach the caller
 * as a plugin that broke rather than as the one outcome it knows how to retry.
 *
 * Everything else is bookkeeping. Turns are rows, so appending one costs one
 * row rather than the transcript; the checkpoint is a column on the session,
 * because there is at most one and it is read on a different path from the
 * turns.
 */

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    flow       TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    turns      INTEGER NOT NULL DEFAULT 0,
    checkpoint TEXT
  );
  CREATE TABLE IF NOT EXISTS turns (
    session   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    position  INTEGER NOT NULL,
    body      TEXT NOT NULL,
    PRIMARY KEY (session, position)
  );
`;

function open(config) {
  const db = new DatabaseSync(config.path ?? ':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

let db;

function ensure(config) {
  db ??= open(config ?? {});
  return db;
}

function now() {
  return new Date().toISOString();
}

function sessionRow(id) {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
}

function turnsOf(id) {
  return db
    .prepare('SELECT body FROM turns WHERE session = ? ORDER BY position')
    .all(id)
    .map((row) => JSON.parse(row.body));
}

function recordOf(row) {
  return {
    id: row.id,
    flow: row.flow ?? undefined,
    createdAt: row.created_at,
    version: row.turns,
    turns: turnsOf(row.id),
  };
}

const store = {
  create({ id, flow }, ctx) {
    ensure(ctx.component);
    // Idempotent, like the file store: a caller asking whether an id is taken
    // uses `read`, and rewriting the row here would move its createdAt.
    db.prepare(
      `INSERT INTO sessions (id, flow, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(id, flow ?? null, now(), now());
    return {};
  },

  read({ id }, ctx) {
    ensure(ctx.component);
    const row = sessionRow(id);
    // null, not undefined: "no such session" is an answer, and the caller
    // distinguishes it from a store that failed to answer at all.
    return row ? recordOf(row) : null;
  },

  append({ id, turn, expect }, ctx) {
    ensure(ctx.component);

    if (!sessionRow(id)) {
      if (expect !== 0) return { conflict: { version: 0 } };
      store.create({ id, flow: turn?.flow }, ctx);
    }

    // The check and the write in one statement. `changes === 0` means the row
    // did not have the version this caller read, so somebody else wrote first.
    const updated = db
      .prepare(
        `UPDATE sessions SET turns = turns + 1, updated_at = ?
         WHERE id = ? AND turns = ?`,
      )
      .run(now(), id, expect);

    if (updated.changes === 0) {
      return { conflict: { version: sessionRow(id).turns } };
    }

    db.prepare(
      'INSERT INTO turns (session, position, body) VALUES (?, ?, ?)',
    ).run(id, expect, JSON.stringify(turn));

    return { version: expect + 1 };
  },

  readCheckpoint({ id }, ctx) {
    ensure(ctx.component);
    const row = sessionRow(id);
    return row?.checkpoint ? JSON.parse(row.checkpoint) : null;
  },

  writeCheckpoint({ id, checkpoint }, ctx) {
    ensure(ctx.component);
    // A durable run can checkpoint before it has anything to say, so this
    // creates the session the same way the file store does.
    if (!sessionRow(id)) store.create({ id }, ctx);

    db.prepare('UPDATE sessions SET checkpoint = ?, updated_at = ? WHERE id = ?').run(
      checkpoint === null ? null : JSON.stringify(checkpoint),
      now(),
      id,
    );
    return {};
  },

  list({ limit, cursor }, ctx) {
    ensure(ctx.component);
    const rows = db
      .prepare('SELECT * FROM sessions ORDER BY updated_at DESC, id DESC')
      .all();

    const start = cursor ? rows.findIndex((row) => row.id === cursor) + 1 : 0;
    const page = rows.slice(start, limit == null ? undefined : start + limit);

    return {
      sessions: page.map((row) => ({
        id: row.id,
        flow: row.flow ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        turns: row.turns,
        unfinished: row.checkpoint !== null,
      })),
    };
  },

  delete({ id }, ctx) {
    ensure(ctx.component);
    db.prepare('DELETE FROM turns WHERE session = ?').run(id);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return {};
  },
};

serve(
  { SqliteSessionStore: store },
  {
    shutdown() {
      db?.close();
      db = undefined;
    },
  },
);
