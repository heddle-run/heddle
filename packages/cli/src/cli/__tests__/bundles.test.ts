import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { BundleError } from '@heddle-run/core';
import {
  downloadBundle,
  fetchRemoteBundle,
  isLibraryName,
  isRemotePath,
  libraryUrl,
} from '../bundles.js';

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

describe('isLibraryName', () => {
  it('reads a bare slug as an entry name', () => {
    expect(isLibraryName('meeting-notes')).toBe(true);
    expect(isLibraryName('docs-qa')).toBe(true);
    expect(isLibraryName('a')).toBe(true);
  });

  it('leaves everything that could name a file alone', () => {
    expect(isLibraryName('flow.yaml')).toBe(false);
    expect(isLibraryName('agent.heddle')).toBe(false);
    expect(isLibraryName('./meeting-notes')).toBe(false);
    expect(isLibraryName('library/dist/docs-qa.heddle')).toBe(false);
    expect(isLibraryName('https://heddle.run/library/docs-qa.heddle')).toBe(
      false,
    );
    expect(isLibraryName('')).toBe(false);
  });
});

describe('libraryUrl', () => {
  it('addresses the entry beside the index', () => {
    expect(libraryUrl('meeting-notes')).toBe(
      'https://heddle.run/library/meeting-notes.heddle',
    );
  });
});

describe('downloadBundle', () => {
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

describe('fetchRemoteBundle', () => {
  it('fetches a bare name from the library', async () => {
    const body = Buffer.from('the meeting-notes archive');
    let asked: string | undefined;
    const origin = await serve((req, res) => {
      asked = req.url;
      res.end(body);
    });

    const fetched = await fetchRemoteBundle('meeting-notes', origin);
    try {
      expect(asked).toBe('/meeting-notes.heddle');
      expect(readFileSync(fetched!.path)).toEqual(body);
      expect(fetched!.path.endsWith('meeting-notes.heddle')).toBe(true);
    } finally {
      fetched?.dispose();
    }
  });

  it('downloads an https:// address as typed', async () => {
    const body = Buffer.from('addressed directly');
    const origin = await serve((_req, res) => res.end(body));

    const fetched = await fetchRemoteBundle(`${origin}/library/docs-qa.heddle`);
    try {
      expect(readFileSync(fetched!.path)).toEqual(body);
    } finally {
      fetched?.dispose();
    }
  });

  it('leaves a local path alone', async () => {
    expect(await fetchRemoteBundle('library/dist/docs-qa.heddle')).toBe(
      undefined,
    );
    expect(await fetchRemoteBundle('./flow.yaml')).toBe(undefined);
  });

  it('lets a file of the same name win over the library', async () => {
    let requests = 0;
    const origin = await serve((_req, res) => {
      requests += 1;
      res.end('never this');
    });

    const dir = mkdtempSync(join(tmpdir(), 'heddle-shadow-'));
    const cwd = process.cwd();
    try {
      writeFileSync(join(dir, 'meeting-notes'), 'a file, not a shorthand');
      process.chdir(dir);
      expect(await fetchRemoteBundle('meeting-notes', origin)).toBe(undefined);
      expect(requests).toBe(0);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says what a 404 means: not a file, not an entry', async () => {
    const origin = await serve((_req, res) => {
      res.statusCode = 404;
      res.end('no such entry');
    });

    await expect(fetchRemoteBundle('gone', origin)).rejects.toThrow(
      /"gone" is not a file here, and the library has no entry by that name/,
    );
  });
});
