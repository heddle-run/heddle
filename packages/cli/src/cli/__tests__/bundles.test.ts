import { readFileSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { BundleError } from '@heddle-run/core';
import { downloadBundle, isRemotePath } from '../bundles.js';

describe('isRemotePath', () => {
  it('recognises http and https URLs', () => {
    expect(isRemotePath('https://heddle.run/library/docs-qa.heddle')).toBe(true);
    expect(isRemotePath('http://localhost:8080/x.heddle')).toBe(true);
  });

  it('leaves local paths alone', () => {
    expect(isRemotePath('library/dist/docs-qa.heddle')).toBe(false);
    expect(isRemotePath('./flow.yaml')).toBe(false);
    expect(isRemotePath('/absolute/flow.json')).toBe(false);
  });
});

describe('downloadBundle', () => {
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  async function serve(
    handler: Parameters<typeof createServer>[1],
  ): Promise<string> {
    server = createServer(handler);
    await new Promise<void>((resolve) => server?.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it('fetches the archive to a temporary file and disposes of it', async () => {
    const body = Buffer.from('not really gzip, but faithfully delivered');
    const origin = await serve((_req, res) => res.end(body));

    const fetched = await downloadBundle(`${origin}/library/docs-qa.heddle`);
    try {
      expect(readFileSync(fetched.path)).toEqual(body);
      expect(fetched.path.endsWith('docs-qa.heddle')).toBe(true);
    } finally {
      fetched.dispose();
    }
    expect(existsSync(dirname(fetched.path))).toBe(false);
  });

  it('refuses a URL that does not name a bundle, without a request', async () => {
    let requests = 0;
    const origin = await serve((_req, res) => {
      requests += 1;
      res.end('flow: {}');
    });

    await expect(downloadBundle(`${origin}/flow.yaml`)).rejects.toThrow(
      BundleError,
    );
    expect(requests).toBe(0);
  });

  it('reports the status of an answer that is not the archive', async () => {
    const origin = await serve((_req, res) => {
      res.statusCode = 404;
      res.end('no such bundle');
    });

    await expect(
      downloadBundle(`${origin}/library/gone.heddle`),
    ).rejects.toThrow(/404/);
  });
});
