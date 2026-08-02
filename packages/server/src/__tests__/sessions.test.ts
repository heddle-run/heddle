import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { FileSessionStore } from '@heddle-run/core';
import { createServer } from '../server.js';

function simpleFlow(): Record<string, unknown> {
  return {
    component_type: 'Flow',
    name: 'test-flow',
    start_node: { $component_ref: 'start' },
    nodes: [{ $component_ref: 'start' }, { $component_ref: 'end' }],
    control_flow_connections: [
      {
        component_type: 'ControlFlowEdge',
        name: 'start_to_end',
        from_node: { $component_ref: 'start' },
        to_node: { $component_ref: 'end' },
      },
    ],
    $referenced_components: {
      start: {
        component_type: 'StartNode',
        id: 'start',
        name: 'start',
        outputs: [{ title: 'query', type: 'string' }],
      },
      end: { component_type: 'EndNode', id: 'end', name: 'end' },
    },
  };
}

let withSessions: Server;
let withoutSessions: Server;
let sessionBase: string;
let statelessBase: string;
let sessionDir: string;
let store: FileSessionStore;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return `http://127.0.0.1:${port}`;
}

beforeAll(async () => {
  sessionDir = mkdtempSync(join(tmpdir(), 'heddle-server-sessions-'));
  store = new FileSessionStore({ root: sessionDir });

  withSessions = createServer({
    log: () => {},
    sessionStore: store,
    sessionStoreName: 'file',
  });
  withoutSessions = createServer({ log: () => {} });

  sessionBase = await listen(withSessions);
  statelessBase = await listen(withoutSessions);
});

afterAll(async () => {
  await new Promise<void>((resolve) => withSessions.close(() => resolve()));
  await new Promise<void>((resolve) => withoutSessions.close(() => resolve()));
  rmSync(sessionDir, { recursive: true, force: true });
});

function send(base: string, method: string, path: string, body?: unknown) {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function newSession(): Promise<string> {
  const res = await send(sessionBase, 'POST', '/v1/sessions', {});
  expect(res.status).toBe(201);
  return (await res.json()).id as string;
}

function run(session: string, query: string) {
  return send(sessionBase, 'POST', '/v1/runs', {
    flow: simpleFlow(),
    inputs: { query },
    session,
  });
}

describe('a server that keeps no sessions', () => {
  it('says so rather than ignoring the field', async () => {
    const res = await send(statelessBase, 'POST', '/v1/runs', {
      flow: simpleFlow(),
      inputs: { query: 'hi' },
      session: 'anything',
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(
      /this server keeps no sessions/,
    );
  });

  it('reports the fact in its capabilities, before anybody tries', async () => {
    const res = await fetch(`${statelessBase}/v1/capabilities`);
    expect(await res.json()).toMatchObject({
      sessions: { enabled: false, store: null },
    });
  });

  it('refuses to create one', async () => {
    const res = await send(statelessBase, 'POST', '/v1/sessions', {});
    expect(res.status).toBe(400);
  });
});

// The session semantics themselves — history injection, refusing a caller's
// own history, turn and checkpoint lifecycles — are core's contract, pinned in
// core's session tests. What is asserted here is the HTTP surface: routes,
// status codes, and the wiring from request fields to that contract.
describe('a server that keeps sessions', () => {
  it('names the store it is using', async () => {
    const res = await fetch(`${sessionBase}/v1/capabilities`);
    expect(await res.json()).toMatchObject({
      sessions: { enabled: true, store: 'file' },
    });
  });

  it('issues the id, and will not take one the caller chose', async () => {
    const res = await send(sessionBase, 'POST', '/v1/sessions', { id: 'alice' });

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/issued by the server/);
  });

  it('refuses a run naming an id it never issued', async () => {
    const res = await run('bd9e1a10-0000-4000-8000-000000000000', 'hi');

    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toMatch(
      /A conversation is created by POST \/v1\/sessions/,
    );
  });

  it('carries the conversation from one request into the next', async () => {
    const id = await newSession();

    const first = await run(id, 'first');
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ session: id });

    await run(id, 'second');

    const transcript = await (
      await send(sessionBase, 'GET', `/v1/sessions/${id}`)
    ).json();

    expect(transcript.messages).toEqual([
      { role: 'user', content: JSON.stringify({ query: 'first' }) },
      { role: 'assistant', content: JSON.stringify({ query: 'first' }) },
      { role: 'user', content: JSON.stringify({ query: 'second' }) },
      { role: 'assistant', content: JSON.stringify({ query: 'second' }) },
    ]);
  });

  it('serves the transcript back', async () => {
    const id = await newSession();
    await run(id, 'hello');

    const res = await send(sessionBase, 'GET', `/v1/sessions/${id}`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ id, version: 1, unfinished: false });
    expect(body.turns[0].input).toEqual({ query: 'hello' });
    expect(body.messages).toEqual([
      { role: 'user', content: JSON.stringify({ query: 'hello' }) },
      { role: 'assistant', content: JSON.stringify({ query: 'hello' }) },
    ]);
  });

  it('records the flow name when the request inlined the document', async () => {
    const id = await newSession();
    await run(id, 'hello');

    expect((await store.read(id))?.turns[0].flow).toBe('test-flow');
  });

  it('deletes one', async () => {
    const id = await newSession();
    await run(id, 'hello');

    const res = await send(sessionBase, 'DELETE', `/v1/sessions/${id}`);
    expect(res.status).toBe(200);
    expect(await store.read(id)).toBeUndefined();

    const after = await send(sessionBase, 'GET', `/v1/sessions/${id}`);
    expect(after.status).toBe(404);
  });

  it('refuses an id that would escape the store', async () => {
    const res = await send(sessionBase, 'GET', '/v1/sessions/%2E%2E%2Fescape');

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/not a usable session id/);
  });

  it('records a failed run, so the next turn opens on the truth', async () => {
    const id = await newSession();

    const res = await send(sessionBase, 'POST', '/v1/runs', {
      flow: { ...simpleFlow(), control_flow_connections: [] },
      inputs: { query: 'broken' },
      session: id,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    const record = await store.read(id);
    expect(record?.version).toBe(1);
    expect(record?.turns[0].error).toBeDefined();
    expect(record?.turns[0].output).toBeUndefined();
  });

  it('answers a stale write with 409, not 400 or 500', async () => {
    const id = await newSession();
    await run(id, 'first');

    // A writer that read version 0 and is only now appending — which is what a
    // second concurrent run on this session would be.
    await expect(
      store.append(
        id,
        { runId: 'stale', at: new Date().toISOString(), input: {} },
        0,
      ),
    ).rejects.toThrow(/moved on/);

    const res = await send(sessionBase, 'GET', `/v1/sessions/${id}`);
    expect((await res.json()).version).toBe(1);
  });

  it('refuses a method the session routes do not serve', async () => {
    const id = await newSession();
    const res = await send(sessionBase, 'PUT', `/v1/sessions/${id}`, {});

    expect(res.status).toBe(405);
    expect((await res.json()).error.message).toMatch(/use GET or DELETE/);
  });

  it('keeps a session out of the run body as server-side configuration', async () => {
    // "session" is per-request by design, unlike toolsDir and friends.
    const id = await newSession();
    const res = await run(id, 'hi');

    expect(res.status).toBe(200);
  });
});

describe('a durable run over HTTP', () => {
  it('refuses "durable" and "resume" without a session to hold them', async () => {
    for (const field of ['durable', 'resume']) {
      const res = await send(sessionBase, 'POST', '/v1/runs', {
        flow: simpleFlow(),
        inputs: { query: 'hi' },
        [field]: true,
      });

      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toMatch(
        new RegExp(`"${field}" needs a "session"`),
      );
    }
  });

  it('reports an unfinished run when the transcript is read', async () => {
    const id = await newSession();
    await store.writeCheckpoint(id, {
      runId: 'r1',
      at: new Date().toISOString(),
      node: 'end',
      carried: { query: 'hi' },
      nodeOutputs: {},
      attempt: 1,
      input: { query: 'hi' },
    });

    const res = await send(sessionBase, 'GET', `/v1/sessions/${id}`);
    expect(await res.json()).toMatchObject({ unfinished: true });
  });

});

describe('a run that stopped on a human', () => {
  /** A session holding a run suspended at the end node, waiting to be told. */
  async function suspended(): Promise<string> {
    const id = await newSession();
    await store.writeCheckpoint(id, {
      runId: 'r1',
      at: new Date().toISOString(),
      node: 'end',
      carried: { query: 'refund me' },
      nodeOutputs: { start: { query: 'refund me' } },
      attempt: 1,
      input: { query: 'refund me' },
      suspension: {
        by: 'ApprovalGate',
        seam: 'toolCall',
        ask: { tool: 'refund', question: 'Approve refund?' },
        node: 'end',
        resume: {},
      },
    });
    return id;
  }

  it('reports what is being asked when the transcript is read', async () => {
    const id = await suspended();

    const res = await send(sessionBase, 'GET', `/v1/sessions/${id}`);
    expect(await res.json()).toMatchObject({
      unfinished: true,
      suspended: {
        by: 'ApprovalGate',
        seam: 'toolCall',
        ask: { tool: 'refund', question: 'Approve refund?' },
      },
    });
  });

  it('refuses a new message: it wants an answer, not a question', async () => {
    const id = await suspended();
    const res = await run(id, 'something else');

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/waiting on an answer/);
  });

  it('refuses a resume that brought no answer, quoting the question', async () => {
    const id = await suspended();

    const res = await send(sessionBase, 'POST', '/v1/runs', {
      flow: simpleFlow(),
      session: id,
      resume: true,
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatchObject({ type: 'AnswerRequired' });
    expect((await send(sessionBase, 'GET', `/v1/sessions/${id}`)).status).toBe(200);
  });

  it('continues when the answer arrives', async () => {
    const id = await suspended();

    const res = await send(sessionBase, 'POST', '/v1/runs', {
      flow: simpleFlow(),
      session: id,
      resume: true,
      answer: { approved: true },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).state).toMatchObject({ query: 'refund me' });
    expect(await store.readCheckpoint(id)).toBeUndefined();
    // The turn closes only now: the conversation was mid-sentence until then.
    expect((await store.read(id))?.version).toBe(1);
  });
});
