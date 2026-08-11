import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { createServer } from '../server.js';

const TOKEN = 'test-token-for-auth';

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer({ authToken: TOKEN });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a bound socket address');
  }
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('with --auth-token set', () => {
  it('keeps health probes open', async () => {
    for (const path of ['/', '/healthz', '/readyz']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
    }
  });

  it('refuses a bare request with 401', async () => {
    const res = await fetch(`${base}/v1/capabilities`);
    expect(res.status).toBe(401);

    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe('Unauthorized');
  });

  it('refuses the wrong token', async () => {
    const res = await fetch(`${base}/v1/capabilities`, {
      headers: { authorization: `Bearer not-${TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  it('refuses the right token under the wrong scheme', async () => {
    const res = await fetch(`${base}/v1/capabilities`, {
      headers: {
        authorization: `Basic ${Buffer.from(TOKEN).toString('base64')}`,
      },
    });
    expect(res.status).toBe(401);
  });

  it('answers the bearer token', async () => {
    const res = await fetch(`${base}/v1/capabilities`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it('checks metrics too', async () => {
    const refused = await fetch(`${base}/metrics`);
    expect(refused.status).toBe(401);

    const allowed = await fetch(`${base}/metrics`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(allowed.status).toBe(200);
  });

  it('refuses an unknown path before revealing whether it exists', async () => {
    const res = await fetch(`${base}/v1/no-such-route`);
    expect(res.status).toBe(401);
  });
});

describe('without --auth-token', () => {
  it('stays the unauthenticated server it always was', async () => {
    const open = createServer();
    await new Promise<void>((resolve) => open.listen(0, '127.0.0.1', resolve));
    const address = open.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected a bound socket address');
    }

    try {
      const res = await fetch(
        `http://127.0.0.1:${address.port}/v1/capabilities`,
      );
      expect(res.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => open.close(() => resolve()));
    }
  });
});
