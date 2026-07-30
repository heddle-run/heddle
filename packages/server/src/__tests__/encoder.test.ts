/**
 * Choosing a rendering, from `?protocol=` to the bytes on the socket.
 *
 * `encoder.test.ts` in core proves the pieces — the builtin encoder's frames,
 * `EncoderStream`'s ordering, what a plugin encoder may declare — and every one
 * of them stops short of a socket. What only this can cover is the join: that
 * `?protocol=` reaches `resolveEncoder`, that the chosen encoder's frames are
 * what the response body actually contains, and that its `contentType` becomes
 * the response header. Drop any of those and core's suite still passes while
 * every client receives heddle's frames whatever it asked for.
 *
 * The first test is the one that matters most and looks the least interesting.
 * Every existing run now goes through an encoder and an asynchronous drain, so
 * the default rendering has to be byte-for-byte what it was — a client that never
 * heard of this phase must not be able to tell it happened.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createServer } from '../server.js';

// packages/server/src/__tests__ -> src -> server -> packages -> root
const repoRoot = join(import.meta.dirname, '../../../../');

/**
 * The flow the example ships, so the README's request is the one under test.
 *
 * Read from disk rather than inlined for `examples/guardrails`'s reason: an
 * example nothing exercises is documentation that rots, and the curl in the
 * README is only trustworthy if this is the same file it names.
 */
const FLOW = JSON.parse(
  readFileSync(join(repoRoot, 'examples/ag-ui/flow.json'), 'utf-8'),
) as Record<string, unknown>;

/**
 * The AG-UI encoder the repository ships, submitted exactly as the README's
 * request submits it.
 *
 * Not a simplified copy. A copy would pass while the shipped one was broken,
 * which is the failure `examples/guardrails` being a live consumer exists to
 * prevent — and this is the only test that carries the example all the way to a
 * socket.
 */
const AG_UI = {
  name: 'ag-ui',
  manifest: JSON.parse(readFileSync(join(repoRoot, 'examples/ag-ui/manifest.json'), 'utf-8')),
  source: readFileSync(join(repoRoot, 'examples/ag-ui/encoder.mjs'), 'utf-8'),
};

/** An encoder whose carrier is not SSE, to prove the header is the encoder's. */
const NDJSON = {
  name: 'ndjson',
  manifest: {
    name: 'ndjson-plugin',
    version: '1.0.0',
    capabilities: [],
    components: [
      {
        componentType: 'NdjsonEncoder',
        kind: 'encoder',
        protocol: 'ndjson',
        contentType: 'application/x-ndjson',
      },
    ],
  },
  source: `serve({
  NdjsonEncoder: {
    encode: (event) => [{ data: { at: event.type } }],
    finish: () => [],
  },
});
`,
};

/** An encoder that cannot render, to prove what a broken rendering does. */
const BROKEN = {
  name: 'broken',
  manifest: {
    name: 'broken-plugin',
    version: '1.0.0',
    capabilities: [],
    components: [
      {
        componentType: 'BrokenEncoder',
        kind: 'encoder',
        protocol: 'broken',
        contentType: 'text/event-stream',
      },
    ],
  },
  source: `serve({
  BrokenEncoder: {
    encode: () => { throw new Error('this encoder cannot count'); },
    finish: () => [],
  },
});
`,
};

interface Frame {
  name: string;
  data: Record<string, unknown>;
}

/** Split an SSE body into frames, keeping the event name beside its payload. */
function frames(body: string): Frame[] {
  const out: Frame[] = [];
  for (const block of body.split('\n\n')) {
    let name = '';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (data.length === 0) continue;
    out.push({ name, data: JSON.parse(data.join('\n')) as Record<string, unknown> });
  }
  return out;
}

let server: Server;
let base: string;
let workDir: string;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'heddle-encoder-server-'));
  server = createServer({ allowRequestCode: true, workDir, log: () => {} });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(workDir, { recursive: true, force: true });
});

function run(query: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/v1/runs${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ flow: JSON.stringify(FLOW), inputs: { text: 'hi' }, ...body }),
  });
}

describe('heddle\'s own rendering, which every existing client is reading', () => {
  it('is unchanged by there being encoders at all', async () => {
    const res = await run('?stream=true', {});

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');

    const all = frames(await res.text());
    // Named frames, the event type as the name, the type inside the payload too
    // — exactly what `sse.test.ts` has always pinned, now reached through an
    // encoder and an asynchronous drain.
    expect(all.map((f) => f.name)).toEqual([
      'flow_start',
      'node_start',
      'node_complete',
      'node_start',
      'node_complete',
      'flow_complete',
    ]);
    expect(all[0].data).toMatchObject({ type: 'flow_start' });
  });

  it('is the same thing when asked for by name', async () => {
    const res = await run('?stream=true&protocol=heddle', {});

    expect(res.status).toBe(200);
    const all = frames(await res.text());
    expect(all.map((f) => f.name)).toContain('flow_complete');
  });

  it('is matched before any plugin is consulted', async () => {
    // The anti-capture guarantee's second half. `claimProtocol` refuses a plugin
    // that declares `heddle`, so this can only be proved from the other side: a
    // request naming it resolves to the builtin without the registry being asked.
    const res = await run('?stream=true&protocol=heddle', { plugins: [AG_UI] });

    const all = frames(await res.text());
    expect(all.map((f) => f.name)).toContain('flow_complete');
    expect(all.every((f) => f.data.type !== 'RUN_STARTED')).toBe(true);
  });
});

describe('a rendering a request submitted', () => {
  it('renders the run in the protocol the client asked for', async () => {
    const res = await run('?stream=true&protocol=ag-ui', { plugins: [AG_UI] });

    expect(res.status).toBe(200);
    const all = frames(await res.text());

    // Nameless frames with the type inside, which is what AG-UI requires and
    // what heddle's own protocol never produces.
    expect(all.every((f) => f.name === '')).toBe(true);
    expect(all.map((f) => f.data.type)).toEqual([
      'RUN_STARTED',
      'STEP_STARTED',
      'STEP_FINISHED',
      'STATE_SNAPSHOT',
      'STEP_STARTED',
      'STEP_FINISHED',
      'STATE_SNAPSHOT',
      'RUN_FINISHED',
    ]);

    // One run identity, minted per request, on the first frame and the last —
    // and `threadId` beside it on both, which the protocol's schema requires and
    // its prose documentation's table for RUN_FINISHED omits.
    const runId = all[0].data.runId;
    expect(typeof runId).toBe('string');
    expect(all[0]).toMatchObject({ data: { threadId: runId } });
    expect(all[all.length - 1].data).toEqual({
      type: 'RUN_FINISHED',
      threadId: runId,
      runId,
    });
  });

  it('sends the content type the encoder declared, not SSE\'s', async () => {
    const res = await run('?stream=true&protocol=ndjson', { plugins: [NDJSON] });

    // A protocol other than heddle's own need not be carried the same way, so
    // the header is the encoder's to choose.
    expect(res.headers.get('content-type')).toBe('application/x-ndjson');
  });

  it('is permitted, unlike a middleware, because it cannot alter the run', async () => {
    // The policy decision in `plugins.ts`. A submitted middleware is a 400; a
    // submitted encoder is the only way this feature is reachable at all, since
    // this server has no operator-plugin path.
    const res = await run('?stream=true&protocol=ag-ui', { plugins: [AG_UI] });

    expect(res.status).toBe(200);
  });

  it('ends the stream and the run when its rendering fails', async () => {
    const res = await run('?stream=true&protocol=broken', { plugins: [BROKEN] });

    // 200, because the headers went out before the first event was rendered —
    // which is why the failure has to travel as a frame.
    expect(res.status).toBe(200);
    const all = frames(await res.text());

    // heddle's own error channel, carrying the encoder's message rather than the
    // `operation was aborted` the run reports after being stopped for it.
    const error = all.find((f) => f.name === 'error');
    expect(error?.data).toMatchObject({ message: expect.stringContaining('cannot count') });
    // And nothing was rendered, so no client is left parsing half a protocol.
    expect(all.filter((f) => f.name === '')).toEqual([]);
  });
});

describe('a protocol this server cannot render', () => {
  it('is refused, naming what it can', async () => {
    const res = await run('?stream=true&protocol=nonesuch', {});

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    // Refused rather than falling back to heddle's frames, which is the failure
    // that costs the most to debug: well-formed frames of a protocol the client
    // does not speak, reported as the protocol being broken.
    expect(body.error.message).toContain('no encoder for protocol "nonesuch"');
    expect(body.error.message).toContain('heddle');
  });

  it('is refused even when the plugin providing it was not submitted', async () => {
    const res = await run('?stream=true&protocol=ag-ui', {});

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('ag-ui');
  });

  it('refuses a protocol on a run that streams nothing', async () => {
    const res = await run('?protocol=ag-ui', { plugins: [AG_UI] });

    // Silently ignoring it would mislead a caller about what they are parsing,
    // which is `rejectServerSideFields`'s rule applied to a query parameter.
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('stream=true');
  });

  it('refuses heddle\'s own name without a stream, though it is the default', async () => {
    const res = await run('?protocol=heddle', {});

    // Naming a protocol is a claim about the response body, and the claim is
    // equally wrong whichever protocol was named. Saying nothing is the only way
    // to ask for the buffered response.
    expect(res.status).toBe(400);
  });

  it('still returns the buffered body when no protocol is named', async () => {
    const res = await run('', {});

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { flow: string };
    expect(body.flow).toBe('ag-ui-demo');
  });
});

describe('what a client can learn before it asks', () => {
  it('reports the protocols it renders and the event contract behind them', async () => {
    const res = await fetch(`${base}/v1/capabilities`);
    const body = (await res.json()) as { protocols: string[]; eventContract: number };

    // A list of one: an encoder arrives with a request, so what this server can
    // render depends on what the caller sends and no probe can enumerate it.
    expect(body.protocols).toEqual(['heddle']);
    expect(body.eventContract).toBe(1);
  });
});
