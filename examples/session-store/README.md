# A session store on SQLite

Where heddle keeps conversations, replaced. The built-in store writes a directory per session under
`~/.heddle/sessions`; this one writes rows, which is the shape a store backed by anything shared has.

```bash
heddle-server \
  --plugin examples/session-store/store.json \
  --session-store SqliteSessionStore \
  --plugin-config SqliteSessionStore='{"path":"/var/lib/heddle/sessions.db"}'
```

`--plugin` installs it, `--session-store` selects it by component type, and `--plugin-config` is how
it is configured — the same three flags any installed component uses. Leave `path` out and it runs in
memory, which is useful for a demo and useless for anything else.

## Why you would

The file store is per-machine. Two replicas behind a load balancer hold two different sets of
conversations under the same ids, so a caller's second message reaches the pod that has never heard
of them. **That is the reason this extension point exists** — not performance, and not durability.
One process on one host is served perfectly well by files.

## What a store has to get right

**The compare-and-swap in `append`.** The `expect` heddle passes is the version it read before the
run started. Here it is a `WHERE turns = ?` on the update, so the check and the write are one
statement; a store that read the version, compared it in JavaScript and then wrote would have a
window between the two, which is the whole thing `expect` exists to close. Two concurrent turns on
one conversation is not a hypothetical the moment sessions are served over HTTP.

**A conflict is a result, not a failure.** A store in another process cannot throw across the
boundary, so it answers `{ conflict: { version } }` and heddle rebuilds a `SessionConflictError` on
its side. Throwing instead reaches the caller as a plugin that broke, rather than as the one outcome
it knows how to retry.

**`null` is an answer.** `read` on an unknown id returns `null` — "no such session" — which is what
every first turn gets. Returning nothing at all is a store that failed to answer, and heddle treats
the two differently on purpose: the second one is a bug that would otherwise look like a conversation
quietly starting over.

## The seven verbs

| Verb | Handler | Answers |
|---|---|---|
| `sessionCreate` | `create` | `{}` |
| `sessionRead` | `read` | a session record, or `null` |
| `sessionAppend` | `append` | `{ version }`, or `{ conflict: { version } }` |
| `sessionCheckpointRead` | `readCheckpoint` | a checkpoint, or `null` |
| `sessionCheckpointWrite` | `writeCheckpoint` | `{}` |
| `sessionList` | `list` | `{ sessions: [...] }` |
| `sessionDelete` | `delete` | `{}` |

Every one carries `config` — the `--plugin-config` for this component — so a store can open its
connection lazily on whichever call arrives first. One that is configured and never used should do
nothing at all.

## What this costs

A store is on the hot path of every turn: at least a `readCheckpoint`, a `read` and an `append` per
message, each one a round trip into this process and each one bounded by `--plugin-timeout` while
holding a concurrency slot. The process is started once and serves every run, which is what makes a
connection pool here worth having — and what makes per-run state in a store a bug.
