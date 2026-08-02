import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');

/**
 * Every design doc, held to the same rules.
 *
 * Was one path. A second doc landed citing the same churn-heavy files, and a
 * rule enforced on one document and not the other is a rule that decays at the
 * rate new documents are written.
 */
const DOCS = [
  'docs/plugin-system-design.md',
  'docs/session-persistence-design.md',
].map((path) => join(ROOT, path));

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
  doc: string;
}

function citations(): Citation[] {
  return DOCS.flatMap((doc) =>
    [...readFileSync(doc, 'utf8').matchAll(CITATION)].map((m) => ({
      path: m[1],
      last: Number(m[3] ?? m[2]),
      text: m[0],
      doc: doc.slice(ROOT.length + 1),
    })),
  );
}

function report(citation: Citation, problem: string): string {
  return `${citation.doc}: ${citation.text} ${problem}`;
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
      .map((c) => report(c, `-> cite \`${c.file}\`, <symbol> instead`));

    expect(offenders).toEqual([]);
  });

  it('name a file that exists, wherever the path is unambiguous', () => {
    const missing = citations()
      .filter((c) => c.path.startsWith('packages/') || c.path.startsWith('vendor/'))
      .filter((c) => !existsSync(join(ROOT, c.path)))
      .map((c) => report(c, 'names no file'));

    expect(missing).toEqual([]);
  });

  it('do not run off the end of the file they name', () => {
    const overruns = citations()
      .filter((c) => c.path.startsWith('packages/') || c.path.startsWith('vendor/'))
      .filter((c) => existsSync(join(ROOT, c.path)))
      .filter((c) => readFileSync(join(ROOT, c.path), 'utf8').split('\n').length < c.last)
      .map((c) => report(c, 'runs off the end'));

    expect(overruns).toEqual([]);
  });
});
