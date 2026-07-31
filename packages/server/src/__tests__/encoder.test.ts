import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createServer } from '../server.js';

const repoRoot = join(import.meta.dirname, '../../../../');

const FLOW = JSON.parse(
  readFileSync(join(repoRoot, 'examples/ag-ui/flow.json'), 'utf-8'),
) as Record<string, unknown>;

const AG_UI = {
  name: 'ag-ui',
  manifest: JSON.parse(readFileSync(join(repoRoot, 'examples/ag-ui/encoder.json'), 'utf-8')),
  source: readFileSync(join(repoRoot, 'examples/ag-ui/encoder.mjs'), 'utf-8'),
};

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

    expect(res.headers.get('content-type')).toBe('application/x-ndjson');
  });

  it('is permitted, unlike a middleware, because it cannot alter the run', async () => {
    const res = await run('?stream=true&protocol=ag-ui', { plugins: [AG_UI] });

    expect(res.status).toBe(200);
  });

  it('ends the stream and the run when its rendering fails', async () => {
    const res = await run('?stream=true&protocol=broken', { plugins: [BROKEN] });

    expect(res.status).toBe(200);
    const all = frames(await res.text());

    const error = all.find((f) => f.name === 'error');
    expect(error?.data).toMatchObject({ message: expect.stringContaining('cannot count') });
    expect(all.filter((f) => f.name === '')).toEqual([]);
  });
});

describe('a protocol this server cannot render', () => {
  it('is refused, naming what it can', async () => {
    const res = await run('?stream=true&protocol=nonesuch', {});

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
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

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('stream=true');
  });

  it('refuses heddle\'s own name without a stream, though it is the default', async () => {
    const res = await run('?protocol=heddle', {});

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

    expect(body.protocols).toEqual(['heddle']);
    expect(body.eventContract).toBe(1);
  });
});
