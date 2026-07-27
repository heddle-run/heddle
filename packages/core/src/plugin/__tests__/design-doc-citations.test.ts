/**
 * The design doc's citations, checked against the tree it cites.
 *
 * Every claim in `docs/plugin-system-design.md` is argued from a pointer into
 * real code, so a pointer that has drifted is not cosmetic — it is the evidence
 * for the claim going missing. Phase 3 made that concrete: `runner/events.ts`
 * grew from ~50 lines to ~165, and `runner/events.ts:4-13` — cited as proof
 * that `EventType` is closed — came to land inside `BuiltinEventType`'s comment
 * about why *it* stays closed. The citation still read as confirming the very
 * claim the surrounding code had just disproved, which is strictly worse than a
 * line number pointing at nothing.
 *
 * Line numbers cannot be checked automatically — nothing here knows which
 * symbol a range was meant to name. So this pins the rule the doc's own
 * preamble states instead: the files that churn most are cited by symbol, and a
 * symbol anchor cannot rot into a false claim because it either resolves or is
 * visibly absent.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** Repository root, from `packages/core/src/plugin/__tests__`. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const DOC = join(ROOT, 'docs/plugin-system-design.md');

/**
 * The files the doc's preamble promises to cite by symbol.
 *
 * These are the ones a phase rewrites rather than appends to, so a line number
 * into them survives roughly one commit. Matched by suffix because the doc
 * writes the same file three ways — `protocol.ts`, `plugin/protocol.ts` and
 * `packages/core/src/plugin/protocol.ts` all appear.
 */
const SYMBOL_ANCHORED = [
  'plugin/types.ts',
  'plugin/executor.ts',
  'plugin/host.ts',
  'plugin/protocol.ts',
  'plugin/transform.ts',
  'runner/events.ts',
];

/** A `file.ts:12` or `file.ts:12-34` inside backticks. */
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

/**
 * Does this citation name one of the symbol-anchored files?
 *
 * A path that carries a directory is matched on a full segment suffix, so
 * `tool/executor.ts` is not mistaken for `plugin/executor.ts` — the two share a
 * basename and only one of them is on the list. A bare basename is treated as
 * the anchored file, which is what catches the `host.ts:223` form the doc used
 * before this rule existed; a bare name is ambiguous anyway, so demanding a
 * symbol for it is the right answer even when it meant the other file.
 */
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

    // Named rather than counted, because the fix is per-citation: whoever
    // trips this has to pick the symbol each range was standing in for, and a
    // bare count would not tell them which ranges to go looking at.
    expect(offenders).toEqual([]);
  });

  it('name a file that exists, wherever the path is unambiguous', () => {
    // Only repository-rooted paths are checked. The doc also cites shorthands
    // like `runner.ts:17`, which resolve by eye from their section and not by
    // any rule this could apply — guessing at them would fail on the guess
    // rather than on the citation.
    const missing = citations()
      .filter((c) => c.path.startsWith('packages/') || c.path.startsWith('vendor/'))
      .filter((c) => !existsSync(join(ROOT, c.path)))
      .map((c) => c.text);

    expect(missing).toEqual([]);
  });

  it('do not run off the end of the file they name', () => {
    // Catches the other half of drift: a citation whose file shrank, or was
    // split, so the range now names lines that are not there at all.
    const overruns = citations()
      .filter((c) => c.path.startsWith('packages/') || c.path.startsWith('vendor/'))
      .filter((c) => existsSync(join(ROOT, c.path)))
      .filter((c) => readFileSync(join(ROOT, c.path), 'utf8').split('\n').length < c.last)
      .map((c) => c.text);

    expect(overruns).toEqual([]);
  });
});
