import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  assertSessionId,
  newSessionId,
  transcriptOf,
  type SessionRecord,
  type SessionStore,
} from '@heddle/core';
import type { ServerConfig } from './config.js';
import { HttpError } from './errors.js';
import { readJsonBody, sendJson } from './http.js';

/**
 * Sessions over HTTP, and the two rules that are not the CLI's.
 *
 * **Ids are issued, never chosen.** `POST /v1/sessions` mints one; a run naming
 * an id this server never issued is a 404 rather than a new conversation by
 * that name. There is no authentication here, so the id is the only thing
 * between a caller and somebody else's transcript — a name anybody could guess
 * is a name anybody could read. On the CLI a chosen id is fine, because the
 * store there is the user's own home directory.
 *
 * **Sessions are off unless the operator turned them on.** With no store
 * configured, `"session"` in a body is a 400. Default-on would have every
 * existing deployment start writing conversations to disk on the next upgrade,
 * which is not an upgrade anybody asked for.
 *
 * Worth saying once, plainly: **a session id is a bearer capability.** Whoever
 * holds it can read and continue that conversation. It is not an authorization
 * boundary and nothing here pretends it is.
 */

export function requireStore(config: ServerConfig): SessionStore {
  if (!config.sessionStore) {
    throw new HttpError(
      400,
      'this server keeps no sessions. Start it with --session-store to hold ' +
        'conversations across requests, or send the history yourself in ' +
        '"inputs" and keep the run stateless.',
      'SessionsDisabled',
    );
  }
  return config.sessionStore;
}

/** The session a run body named, refused unless this server issued it. */
export async function resolveSession(
  config: ServerConfig,
  raw: unknown,
): Promise<{ store: SessionStore; id: string; record: SessionRecord }> {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new HttpError(400, '"session" must be a session id string');
  }

  const store = requireStore(config);
  const id = validId(raw);

  // Kept and handed onward, so opening the turn does not read it again.
  const record = await store.read(id);
  if (record === undefined) {
    throw new HttpError(404, unknownSessionMessage(id), 'NoSuchSession');
  }
  return { store, id, record };
}

export async function handleCreateSession(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
  headers: Record<string, string>,
): Promise<void> {
  const body = await readJsonBody(req, config.maxBodyBytes);
  if ('id' in body) {
    throw new HttpError(
      400,
      'a session id is issued by the server, never chosen by the caller. This ' +
        'server has no authentication, so the id is the only thing protecting ' +
        'a conversation — one a caller picked is one a caller could guess.',
    );
  }

  const store = requireStore(config);
  const id = newSessionId();
  await store.create(id, { flow: readFlowHint(body) });

  sendJson(res, 201, { id }, headers);
}

export async function handleReadSession(
  res: ServerResponse,
  config: ServerConfig,
  rawId: string,
  headers: Record<string, string>,
): Promise<void> {
  const store = requireStore(config);
  const id = validId(rawId);

  const record = await store.read(id);
  if (!record) {
    throw new HttpError(404, unknownSessionMessage(id), 'NoSuchSession');
  }

  const checkpoint = await store.readCheckpoint(id);

  sendJson(
    res,
    200,
    {
      id: record.id,
      flow: record.flow,
      createdAt: record.createdAt,
      version: record.version,
      turns: record.turns,
      // The same turns as the model is shown them, so a client rendering a
      // conversation does not have to reimplement the rendering the agent uses.
      messages: transcriptOf(record),
      unfinished: checkpoint !== undefined,
      ...(checkpoint?.suspension
        ? {
            suspended: {
              by: checkpoint.suspension.by,
              seam: checkpoint.suspension.seam,
              ask: checkpoint.suspension.ask,
            },
          }
        : {}),
    },
    headers,
  );
}

export async function handleDeleteSession(
  res: ServerResponse,
  config: ServerConfig,
  rawId: string,
  headers: Record<string, string>,
): Promise<void> {
  const store = requireStore(config);
  const id = validId(rawId);

  await store.delete(id);
  sendJson(res, 200, { id, deleted: true }, headers);
}

/** The core rule, so there is one definition of what an id may look like. */
function validId(id: string): string {
  try {
    assertSessionId(id);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  return id;
}

function readFlowHint(body: Record<string, unknown>): string | undefined {
  const { flow } = body;
  return typeof flow === 'string' && flow.length > 0 ? flow : undefined;
}

function unknownSessionMessage(id: string): string {
  return (
    `no session "${id}". A conversation is created by POST /v1/sessions, ` +
    `which issues the id — this server does not create one from an id a ` +
    `request named.`
  );
}
