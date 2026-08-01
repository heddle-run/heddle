import { Command } from 'commander';
import {
  FileSessionStore,
  assertSessionId,
  newSessionId,
  transcriptOf,
  type SessionStore,
} from '@heddle/core';

/**
 * What `--session` was given, as commander hands it over.
 *
 * `true` is the flag with no value — "persist this, and name it for me". A
 * string is a conversation the caller already has.
 */
export interface SessionFlags {
  session?: string | boolean;
  sessionDir?: string;
}

export interface SelectedSession {
  store: SessionStore;
  id: string;
  /** Whether this invocation is what created it, so the id gets announced. */
  fresh: boolean;
}

export function storeFor(flags: SessionFlags): FileSessionStore {
  return new FileSessionStore({ root: flags.sessionDir });
}

/**
 * The session this run belongs to, if it belongs to one.
 *
 * An id the caller chose is honoured here and refused on the server, and the
 * asymmetry is deliberate: this store is the user's own home directory, where a
 * memorable name costs nothing. On a server the id is the only thing between a
 * caller and somebody else's conversation.
 */
export function selectSession(
  flags: SessionFlags,
): SelectedSession | undefined {
  if (flags.session === undefined || flags.session === false) return undefined;

  const chosen = flags.session === true ? newSessionId() : flags.session;
  assertSessionId(chosen);

  return { store: storeFor(flags), id: chosen, fresh: flags.session === true };
}

export const sessionsCommand = new Command('sessions')
  .description('Inspect the conversations heddle has kept')
  .option('--session-dir <dir>', 'Where sessions are kept');

sessionsCommand
  .command('ls')
  .description('List sessions, most recently used first')
  .option('--limit <n>', 'How many to show')
  .action(async (options: { limit?: string }, command: Command) => {
    const flags = command.parent?.opts() as SessionFlags;
    const store = storeFor(flags);
    const sessions = await store.list({ limit: toLimit(options.limit) });

    if (sessions.length === 0) {
      console.error(`no sessions in ${store.location()}`);
      return;
    }

    for (const session of sessions) {
      const state = session.unfinished ? 'unfinished' : `${session.turns} turns`;
      console.log(
        `${session.id}  ${session.updatedAt}  ${state}  ${session.flow ?? ''}`.trimEnd(),
      );
    }
  });

sessionsCommand
  .command('show')
  .description('Print a session transcript')
  .argument('<id>', 'Session id')
  .option('--json', 'Print the stored record rather than the conversation')
  .action(async (id: string, options: { json?: boolean }, command: Command) => {
    const store = storeFor(command.parent?.opts() as SessionFlags);
    const record = await store.read(id);
    if (!record) throw new Error(`no session "${id}"`);

    if (options.json) {
      console.log(JSON.stringify(record, null, 2));
      return;
    }

    for (const message of transcriptOf(record)) {
      console.log(`${message.role === 'user' ? '>' : '<'} ${message.content}`);
    }

    const checkpoint = await store.readCheckpoint(id);
    if (checkpoint) {
      console.error(unfinishedNote(checkpoint.node, checkpoint.suspension?.by));
    }
  });

sessionsCommand
  .command('rm')
  .description('Delete a session and everything in it')
  .argument('<id>', 'Session id')
  .action(async (id: string, _options: unknown, command: Command) => {
    const store = storeFor(command.parent?.opts() as SessionFlags);
    await store.delete(id);
    console.error(`deleted session ${id}`);
  });

function unfinishedNote(node: string, suspendedBy: string | undefined): string {
  return suspendedBy
    ? `\nThis session is waiting on an answer: "${suspendedBy}" stopped the ` +
        `run at "${node}". Continue it with --resume.`
    : `\nThis session has an unfinished run, stopped at "${node}". Continue ` +
        `it with --resume.`;
}

function toLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;

  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('--limit must be a whole number of 1 or more');
  }
  return limit;
}
