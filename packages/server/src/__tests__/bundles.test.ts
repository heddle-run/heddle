/**
 * Bundles over HTTP, end to end: a real archive packed by core's own
 * `packBundle`, uploaded, read back, deleted, and run — by stored id and as
 * inline bytes — with the three things a bundle carries that a plain flow
 * cannot all exercised in one program: an executable tool, a mount the tool
 * reads, and a recorded default input the caller may override.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { checkedMount, packBundle, FileSessionStore } from '@heddle-run/core';
import { createServer } from '../server.js';
import { DEFAULT_MAX_BUNDLE_BYTES } from '../config.js';

const GREETING = 'salutations from the mount';

/** Reads the mounted file out of the workspace the run gave it. */
const READ_GREETING = `#!/bin/sh
cat > /dev/null
root="\${HEDDLE_WORKSPACE:-$PWD}"
printf '{"greeting": "%s"}' "$(cat "$root/data/greeting.txt")"
`;

function greeterFlow(): Record<string, unknown> {
  return {
    component_type: 'Flow',
    name: 'greeter-flow',
    start_node: { $component_ref: 'start' },
    nodes: [
      { $component_ref: 'start' },
      { $component_ref: 'greet' },
      { $component_ref: 'end' },
    ],
    control_flow_connections: [
      {
        component_type: 'ControlFlowEdge',
        name: 'start_to_greet',
        from_node: { $component_ref: 'start' },
        to_node: { $component_ref: 'greet' },
      },
      {
        component_type: 'ControlFlowEdge',
        name: 'greet_to_end',
        from_node: { $component_ref: 'greet' },
        to_node: { $component_ref: 'end' },
      },
    ],
    $referenced_components: {
      start: {
        component_type: 'StartNode',
        id: 'start',
        name: 'start',
        outputs: [{ title: 'note', type: 'string' }],
      },
      greet: {
        component_type: 'ToolNode',
        id: 'greet',
        name: 'greet',
        tool: {
          component_type: 'ServerTool',
          id: 'read_greeting',
          name: 'read_greeting',
          description: 'reads the mounted greeting',
          outputs: [{ title: 'greeting', type: 'string' }],
        },
      },
      end: { component_type: 'EndNode', id: 'end', name: 'end' },
    },
  };
}

function trivialFlow(): Record<string, unknown> {
  return {
    component_type: 'Flow',
    name: 'trivial-flow',
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

const HEX_ID = /^[0-9a-f]{64}$/;
const UNKNOWN_ID = '0'.repeat(64);

let scratch: string;
let bundlesDir: string;
let greeterBytes: Buffer;
let trivialBytes: Buffer;

let server: Server;
let base: string;
let sessionServer: Server;
let sessionBase: string;
let refusingServer: Server;
let refusingBase: string;

async function listen(s: Server): Promise<string> {
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const address = s.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return `http://127.0.0.1:${port}`;
}

function close(s: Server): Promise<void> {
  return new Promise((resolve) => s.close(() => resolve()));
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'heddle-server-bundles-test-'));
  bundlesDir = join(scratch, 'store');

  // The greeter: flow + one executable tool + a mount the tool reads + a
  // recorded default input. Packed by the same code `heddle bundle` runs.
  const greeterDir = join(scratch, 'greeter');
  mkdirSync(greeterDir);
  const flowPath = join(greeterDir, 'flow.json');
  writeFileSync(flowPath, JSON.stringify(greeterFlow()));

  const toolsDir = join(greeterDir, 'tools');
  mkdirSync(toolsDir);
  const toolPath = join(toolsDir, 'read_greeting');
  writeFileSync(toolPath, READ_GREETING);
  chmodSync(toolPath, 0o755);

  const mountSource = join(greeterDir, 'greeting.txt');
  writeFileSync(mountSource, GREETING);

  const greeterArchive = join(scratch, 'greeter.heddle');
  packBundle(
    {
      name: 'greeter',
      flowPath,
      toolsDir,
      pluginManifests: [],
      pluginConfig: {},
      mounts: [
        checkedMount({
          source: mountSource,
          dest: 'data/greeting.txt',
          mode: 'ro',
          origin: 'test',
        }),
      ],
      input: { note: 'from-the-bundle' },
    },
    greeterArchive,
  );
  greeterBytes = readFileSync(greeterArchive);

  // A second, different archive, so the delete tests have an id whose removal
  // breaks nothing the other tests still need.
  const trivialDir = join(scratch, 'trivial');
  mkdirSync(trivialDir);
  const trivialFlowPath = join(trivialDir, 'flow.json');
  writeFileSync(trivialFlowPath, JSON.stringify(trivialFlow()));

  const trivialArchive = join(scratch, 'trivial.heddle');
  packBundle(
    {
      name: 'trivial',
      flowPath: trivialFlowPath,
      pluginManifests: [],
      pluginConfig: {},
      mounts: [],
    },
    trivialArchive,
  );
  trivialBytes = readFileSync(trivialArchive);

  server = createServer({ bundlesDir, workDir: scratch, log: () => {} });
  base = await listen(server);

  sessionServer = createServer({
    bundlesDir,
    workDir: scratch,
    sessionStore: new FileSessionStore({ root: join(scratch, 'sessions') }),
    sessionStoreName: 'file',
    log: () => {},
  });
  sessionBase = await listen(sessionServer);

  refusingServer = createServer({ bundles: false, log: () => {} });
  refusingBase = await listen(refusingServer);
});

afterAll(async () => {
  await close(server);
  await close(sessionServer);
  await close(refusingServer);
});

function upload(at: string, bytes: Buffer) {
  return fetch(`${at}/v1/bundles`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-heddle' },
    body: new Uint8Array(bytes),
  });
}

function post(at: string, path: string, body: unknown) {
  return fetch(`${at}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

let greeterId: string;

describe('POST /v1/bundles', () => {
  it('stores an archive and answers 201 with its content id', async () => {
    const res = await upload(base, greeterBytes);
    expect(res.status).toBe(201);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toMatch(HEX_ID);
    expect(body.name).toBe('greeter');
    expect(body.input).toEqual({ note: 'from-the-bundle' });
    // Executable tools and a mount both make this bundle need a host that
    // starts processes, and the upload response is where a client learns that.
    expect(body.portable).toBe(false);
    expect(Array.isArray(body.reasons)).toBe(true);
    expect((body.reasons as string[]).length).toBeGreaterThan(0);

    greeterId = body.id as string;
  });

  it('answers 200 with the same id when the same bytes come again', async () => {
    const res = await upload(base, greeterBytes);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe(greeterId);
  });

  it('refuses an empty body', async () => {
    const res = await fetch(`${base}/v1/bundles`, { method: 'POST' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('empty');
  });

  it('refuses bytes that are not an archive', async () => {
    const res = await upload(base, Buffer.from('this is not gzip'));
    expect(res.status).toBe(400);
  });
});

describe('GET and DELETE /v1/bundles/<id>', () => {
  it('reads a stored bundle back', async () => {
    const res = await fetch(`${base}/v1/bundles/${greeterId}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: greeterId,
      name: 'greeter',
      portable: false,
    });
  });

  it('404s an id nothing was stored under', async () => {
    const res = await fetch(`${base}/v1/bundles/${UNKNOWN_ID}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe('NoSuchBundle');
  });

  it('400s something that is not a bundle id at all', async () => {
    const res = await fetch(`${base}/v1/bundles/not-an-id`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('64 hex characters');
  });

  it('deletes, and a run naming the deleted id is a 404', async () => {
    const uploaded = await upload(base, trivialBytes);
    expect(uploaded.status).toBe(201);
    const { id } = (await uploaded.json()) as { id: string };

    const deleted = await fetch(`${base}/v1/bundles/${id}`, {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ id, deleted: true });

    const read = await fetch(`${base}/v1/bundles/${id}`);
    expect(read.status).toBe(404);

    const run = await post(base, '/v1/runs', { bundle: id });
    expect(run.status).toBe(404);
    const body = (await run.json()) as { error: { type: string } };
    expect(body.error.type).toBe('NoSuchBundle');
  });
});

describe('POST /v1/runs with a stored bundle', () => {
  it('runs the bundle: tool executes, mount is visible, default input holds', async () => {
    const res = await post(base, '/v1/runs', { bundle: greeterId });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      flow: 'greeter-flow',
      state: { note: 'from-the-bundle', greeting: GREETING },
    });
  });

  it('lets the body override the recorded input', async () => {
    const res = await post(base, '/v1/runs', {
      bundle: greeterId,
      inputs: { note: 'changed-my-mind' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      state: { note: 'changed-my-mind', greeting: GREETING },
    });
  });

  it('streams the run as SSE frames', async () => {
    const res = await post(base, '/v1/runs?stream=true', {
      bundle: greeterId,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const text = await res.text();
    const events = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(events[0]).toBe('flow_start');
    expect(events[events.length - 1]).toBe('flow_complete');
    expect(events).toContain('node_start');

    const frames = text.trim().split('\n\n');
    const last = JSON.parse(frames[frames.length - 1].split('\ndata: ')[1]);
    expect(last).toMatchObject({
      type: 'flow_complete',
      state: { note: 'from-the-bundle', greeting: GREETING },
    });
  });

  it('404s an id nothing was stored under', async () => {
    const res = await post(base, '/v1/runs', { bundle: UNKNOWN_ID });
    expect(res.status).toBe(404);
  });

  it('400s a bundle id that is not one', async () => {
    const res = await post(base, '/v1/runs', { bundle: 'nope' });
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/runs with inline bundleData', () => {
  it('runs the archive without storing it', async () => {
    const res = await post(base, '/v1/runs', {
      bundleData: greeterBytes.toString('base64'),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      flow: 'greeter-flow',
      state: { note: 'from-the-bundle', greeting: GREETING },
    });
  });

  it('refuses garbage base64 as an encoding problem, not an archive one', async () => {
    const res = await post(base, '/v1/runs', { bundleData: '!!!not-base64!!!' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('not valid base64');
  });

  it('refuses base64 of something that is not an archive', async () => {
    const res = await post(base, '/v1/runs', {
      bundleData: Buffer.from('not a bundle').toString('base64'),
    });
    expect(res.status).toBe(400);
  });
});

describe('a bundle and a bundle-carried field cannot share a request', () => {
  it('refuses bundle beside an inline flow', async () => {
    const res = await post(base, '/v1/runs', {
      bundle: greeterId,
      flow: trivialFlow(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('"flow" cannot be sent with "bundle"');
  });

  it('refuses bundle beside submitted tools, before request-code policy', async () => {
    const res = await post(base, '/v1/runs', { bundle: greeterId, tools: [] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain(
      '"tools" cannot be sent with "bundle"',
    );
  });

  it('refuses bundle and bundleData together', async () => {
    const res = await post(base, '/v1/runs', {
      bundle: greeterId,
      bundleData: greeterBytes.toString('base64'),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('not both');
  });
});

describe('size limits', () => {
  it('413s an upload over --max-bundle-bytes', async () => {
    const tiny = createServer({
      maxBundleBytes: 64,
      bundlesDir: join(scratch, 'tiny-store'),
      log: () => {},
    });
    const tinyBase = await listen(tiny);
    try {
      const res = await upload(tinyBase, greeterBytes);
      expect(res.status).toBe(413);

      const inline = await post(tinyBase, '/v1/runs', {
        bundleData: greeterBytes.toString('base64'),
      });
      expect(inline.status).toBe(413);
      const body = (await inline.json()) as { error: { message: string } };
      expect(body.error.message).toContain('decodes to');
    } finally {
      await close(tiny);
    }
  });

  it('raises the run body cap by the base64 cost of one archive', async () => {
    // A body cap smaller than the archive's own base64: without the raise,
    // this request could not even be read.
    const small = createServer({
      maxBodyBytes: 256,
      bundlesDir: join(scratch, 'small-store'),
      workDir: scratch,
      log: () => {},
    });
    const smallBase = await listen(small);
    try {
      const res = await post(smallBase, '/v1/runs', {
        bundleData: greeterBytes.toString('base64'),
      });
      expect(res.status).toBe(200);
    } finally {
      await close(small);
    }
  });
});

describe('sessions and bundles', () => {
  it('a bundle conversation must be resumed with the bundle repeated', async () => {
    await upload(sessionBase, greeterBytes);

    const created = await post(sessionBase, '/v1/sessions', {});
    expect(created.status).toBe(201);
    const { id: session } = (await created.json()) as { id: string };

    const first = await post(sessionBase, '/v1/runs', {
      bundle: greeterId,
      session,
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ session });

    // Resumed without the bundle: refused with a hint naming the id, however
    // plausible the flow it brought instead looks.
    const bare = await post(sessionBase, '/v1/runs', {
      session,
      resume: true,
      flow: trivialFlow(),
    });
    expect(bare.status).toBe(400);
    const refusal = (await bare.json()) as { error: { message: string } };
    expect(refusal.error.message).toContain(greeterId);
    expect(refusal.error.message).toContain('"bundle"');

    // With the bundle repeated the gate opens — what is left to complain about
    // is that this conversation finished cleanly and has no checkpoint, which
    // is the session store speaking, not the bundle rule.
    const repeated = await post(sessionBase, '/v1/runs', {
      session,
      resume: true,
      bundle: greeterId,
    });
    expect(repeated.status).toBe(400);
    const outcome = (await repeated.json()) as { error: { message: string } };
    expect(outcome.error.message).toContain('nothing to resume');
  });
});

describe('--no-bundles', () => {
  it('refuses every bundle route', async () => {
    const uploaded = await upload(refusingBase, greeterBytes);
    expect(uploaded.status).toBe(400);
    const body = (await uploaded.json()) as { error: { message: string } };
    expect(body.error.message).toContain('--no-bundles');

    const read = await fetch(`${refusingBase}/v1/bundles/${UNKNOWN_ID}`);
    expect(read.status).toBe(400);

    const deleted = await fetch(`${refusingBase}/v1/bundles/${UNKNOWN_ID}`, {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(400);
  });

  it('refuses the run fields by name', async () => {
    const byId = await post(refusingBase, '/v1/runs', { bundle: UNKNOWN_ID });
    expect(byId.status).toBe(400);
    const body = (await byId.json()) as { error: { message: string } };
    expect(body.error.message).toContain('"bundle" is not accepted');

    const inline = await post(refusingBase, '/v1/runs', {
      bundleData: greeterBytes.toString('base64'),
    });
    expect(inline.status).toBe(400);
  });

  it('says so in capabilities', async () => {
    const res = await fetch(`${refusingBase}/v1/capabilities`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      bundles: { enabled: false, store: false },
    });
  });
});

describe('capabilities', () => {
  it('advertises the store, the limit, and the limit again under limits', async () => {
    const res = await fetch(`${base}/v1/capabilities`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bundles: Record<string, unknown>;
      limits: Record<string, unknown>;
    };
    expect(body.bundles).toEqual({
      enabled: true,
      maxBytes: DEFAULT_MAX_BUNDLE_BYTES,
      store: true,
    });
    expect(body.limits.maxBundleBytes).toBe(DEFAULT_MAX_BUNDLE_BYTES);
  });
});
