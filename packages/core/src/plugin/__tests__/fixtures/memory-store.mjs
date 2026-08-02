/**
 * The smallest store that answers all seven verbs, held in memory.
 *
 * A fixture rather than an example: `examples/session-store` is the one worth
 * reading, and it is backed by SQLite because that is the shape a real store
 * has. `node:sqlite` arrived in Node 22.5 and this repo supports Node 18, so
 * the example cannot run everywhere — and the thing most worth testing is not
 * SQL, it is that the *protocol* survives a process boundary.
 *
 * So this proves the wire: every verb, `null` distinguished from no answer, and
 * a conflict reported as a result rather than thrown. It uses nothing newer
 * than a Map.
 */

const sessions = new Map();

function record(id) {
  return sessions.get(id);
}

/* A plain function rather than `this.create`: the runtime looks the handler up
   and calls it detached, so `this` is not the handler object. */
function ensure(id, flow) {
  if (!sessions.has(id)) {
    sessions.set(id, {
      id,
      flow,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      turns: [],
      checkpoint: null,
    });
  }
}

serve({
  MemorySessionStore: {
    create({ id, flow }) {
      // Idempotent, like every store: a caller asking whether an id is taken
      // uses `read`, and rewriting here would move its createdAt.
      ensure(id, flow);
      return {};
    },

    read({ id, config }) {
      const held = record(id);
      // null, not undefined: "no such session" is an answer, and heddle
      // distinguishes it from a store that failed to answer at all.
      if (!held) return null;

      return {
        id: held.id,
        // Proves the store's own configuration crossed the boundary — it rides
        // on every call, because no verb constructs a store.
        flow: config?.label ?? held.flow,
        createdAt: held.createdAt,
        version: held.turns.length,
        turns: held.turns,
      };
    },

    append({ id, turn, expect }) {
      if (!record(id)) {
        if (expect !== 0) return { conflict: { version: 0 } };
        ensure(id, turn?.flow);
      }

      const held = record(id);
      // The compare-and-swap. In one process a check and a push cannot
      // interleave, so this is trivially atomic here — the point is that the
      // *answer shape* is what heddle rebuilds a SessionConflictError from.
      if (held.turns.length !== expect) {
        return { conflict: { version: held.turns.length } };
      }

      held.turns.push(turn);
      held.updatedAt = new Date().toISOString();
      return { version: held.turns.length };
    },

    readCheckpoint({ id }) {
      return record(id)?.checkpoint ?? null;
    },

    writeCheckpoint({ id, checkpoint }) {
      if (!record(id)) ensure(id);
      record(id).checkpoint = checkpoint;
      return {};
    },

    list({ limit, cursor }) {
      const all = [...sessions.values()]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((held) => ({
          id: held.id,
          flow: held.flow,
          createdAt: held.createdAt,
          updatedAt: held.updatedAt,
          turns: held.turns.length,
          unfinished: held.checkpoint !== null,
        }));

      const start = cursor ? all.findIndex((s) => s.id === cursor) + 1 : 0;
      return {
        sessions: limit == null ? all.slice(start) : all.slice(start, start + limit),
      };
    },

    delete({ id }) {
      sessions.delete(id);
      return {};
    },
  },
});
