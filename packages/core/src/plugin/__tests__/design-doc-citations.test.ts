import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const DOC = join(ROOT, 'docs/plugin-system-design.md');

const SYMBOL_ANCHORED = [
  'plugin/types.ts',
  'plugin/executor.ts',
  'plugin/host.ts',
  'plugin/protocol.ts',
  'plugin/transform.ts',
  'runner/events.ts',
];

const CITATION = /`([A-Za-z0-9_@/.-]+\.tsx?):(\d+)(?:-(\d+))?`/g;

interface Citation {
  path: string;
  last: number;
  text: string;
}

function citations(): Citation[] {
  const doc = readFileSync(DOC, 'utf8');
  return [...doc.matchAll(CITATION)].map((m) => ({
    path: m[1],
    last: Number(m[3] ?? m[2]),
    text: m[0],
  }));
}

function isAnchored(path: string): string | undefined {
  return path.includes('/')
    ? SYMBOL_ANCHORED.find((f) => path === f || path.endsWith(`/${f}`))
    : SYMBOL_ANCHORED.find((f) => f.endsWith(`/${path}`));
}

describe('the design doc citations', () => {
  it('cite the churn-heavy files by symbol, never by line', () => {
    const offenders = citations()
      .map((c) => ({ ...c, file: isAnchored(c.path) }))
      .filter((c) => c.file !== undefined)
      .map((c) => `${c.text} -> cite \`${c.file}\`, <symbol> instead`);

    expect(offenders).toEqual([]);
  });

  it('name a file that exists, wherever the path is unambiguous', () => {
    const missing = citations()
      .filter((c) => c.path.startsWith('packages/') || c.path.startsWith('vendor/'))
      .filter((c) => !existsSync(join(ROOT, c.path)))
      .map((c) => c.text);

    expect(missing).toEqual([]);
  });

  it('do not run off the end of the file they name', () => {
    const overruns = citations()
      .filter((c) => c.path.startsWith('packages/') || c.path.startsWith('vendor/'))
      .filter((c) => existsSync(join(ROOT, c.path)))
      .filter((c) => readFileSync(join(ROOT, c.path), 'utf8').split('\n').length < c.last)
      .map((c) => c.text);

    expect(overruns).toEqual([]);
  });
});
