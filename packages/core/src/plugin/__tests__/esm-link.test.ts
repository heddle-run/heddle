/**
 * The portable ESM linker: `linkEntry` + `evaluateLinked`.
 *
 * Two properties are on trial. Everything the linker accepts must evaluate
 * with the semantics a real module loader would give the same files — proven
 * by running the linked output and looking at what comes out. And everything
 * it cannot read must come back as a problem, never as a silent rewrite —
 * proven by feeding it the shapes that fooled the old line-regex (imports
 * inside template literals, member names, comments) and the shapes it
 * deliberately refuses (bare specifiers, cycles, destructured exports).
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateLinked,
  linkEntry,
  usesModuleSyntax,
} from '../esm-link.js';

/** Link and evaluate; whatever entry passes to the injected `out` is kept. */
function evaluate(
  entry: string,
  files: Record<string, string> = {},
): unknown[] {
  const linked = linkEntry({
    source: entry,
    read: (path) => files[path] ?? null,
  });
  if (!linked.ok) {
    throw new Error(`did not link: ${linked.problems.join('; ')}`);
  }
  const seen: unknown[] = [];
  evaluateLinked(linked.modules, { out: (value: unknown) => seen.push(value) });
  return seen;
}

function problems(
  entry: string,
  files: Record<string, string> = {},
): string[] {
  const linked = linkEntry({
    source: entry,
    read: (path) => files[path] ?? null,
  });
  if (linked.ok) throw new Error('expected the link to be refused');
  return linked.problems;
}

describe('linking that a loader would agree with', () => {
  it('links a default export to a default import', () => {
    const seen = evaluate(
      `import greet from './greet.js';\nout(greet('io'));`,
      { 'greet.js': `export default function greet(name) { return 'hi ' + name; }` },
    );
    expect(seen).toEqual(['hi io']);
  });

  it('links named exports, aliases on both ends included', () => {
    const seen = evaluate(
      `import { first, renamed as second } from './lib.mjs';\nout(first + second);`,
      { 'lib.mjs': `const hidden = 2;\nexport const first = 1;\nexport { hidden as renamed };` },
    );
    expect(seen).toEqual([3]);
  });

  it('links a namespace import', () => {
    const seen = evaluate(
      `import * as lib from './lib.js';\nout(lib.a + lib.b);`,
      { 'lib.js': `export const a = 1, b = 2;` },
    );
    expect(seen).toEqual([3]);
  });

  it('links a default binding combined with named bindings', () => {
    const seen = evaluate(
      `import main, { extra } from './lib.js';\nout(main() + extra);`,
      { 'lib.js': `export default () => 10;\nexport const extra = 5;` },
    );
    expect(seen).toEqual([15]);
  });

  it('runs a side-effect import exactly once, deps first', () => {
    const seen = evaluate(
      `import './a.js';\nimport './b.js';\nout('entry');`,
      {
        'a.js': `import './b.js';\nout('a');`,
        'b.js': `out('b');`,
      },
    );
    expect(seen).toEqual(['b', 'a', 'entry']);
  });

  it('evaluates a diamond dependency once', () => {
    const seen = evaluate(
      `import { left } from './left.js';\nimport { right } from './right.js';\nout(left === right);`,
      {
        'left.js': `import { shared } from './shared.js';\nexport const left = shared;`,
        'right.js': `import { shared } from './shared.js';\nexport const right = shared;`,
        'shared.js': `export const shared = {};`,
      },
    );
    expect(seen).toEqual([true]);
  });

  it('resolves imports relative to the importing module, not the entry', () => {
    const seen = evaluate(
      `import { answer } from './lib/deep.js';\nout(answer);`,
      {
        'lib/deep.js': `import { base } from './util.js';\nexport const answer = base + 1;`,
        'lib/util.js': `export const base = 41;`,
      },
    );
    expect(seen).toEqual([42]);
  });

  it('lets a nested module climb back toward the plugin root', () => {
    const seen = evaluate(
      `import { v } from './lib/mod.js';\nout(v);`,
      {
        'lib/mod.js': `import { root } from '../root.js';\nexport const v = root;`,
        'root.js': `export const root = 'top';`,
      },
    );
    expect(seen).toEqual(['top']);
  });

  it('exports declarations of every spelling', () => {
    const seen = evaluate(
      `import * as m from './m.js';\n` +
        `out([m.fn(), m.C.name, m.later() instanceof Promise, [...m.gen()], m.a, m.b, m.mut]);`,
      {
        'm.js':
          `export function fn() { return 'fn'; }\n` +
          `export class C {}\n` +
          `export async function later() { return 'later'; }\n` +
          `export function* gen() { yield 1; }\n` +
          `export const a = 'a', b = 'b';\n` +
          `export let mut = 'before';\nmut = 'after';`,
      },
    );
    // `mut` is a snapshot taken when the module finishes, so the final value.
    expect(seen).toEqual([['fn', 'C', true, [1], 'a', 'b', 'after']]);
  });

  it('supports export default of an expression', () => {
    const seen = evaluate(
      `import obj from './obj.js';\nout(obj.k);`,
      { 'obj.js': `export default { k: 'v' };` },
    );
    expect(seen).toEqual(['v']);
  });

  it('re-exports named bindings from another module', () => {
    const seen = evaluate(
      `import { a, c } from './facade.js';\nout(a + c);`,
      {
        'facade.js': `export { a, b as c } from './base.js';`,
        'base.js': `export const a = 1;\nexport const b = 2;`,
      },
    );
    expect(seen).toEqual([3]);
  });

  it('re-exports a star, default excluded', () => {
    const seen = evaluate(
      `import * as all from './facade.js';\nout([all.a, all.b, all.default]);`,
      {
        'facade.js': `export * from './base.js';`,
        'base.js': `export const a = 1;\nexport const b = 2;\nexport default 'hidden';`,
      },
    );
    expect(seen).toEqual([[1, 2, undefined]]);
  });

  it('re-exports a star as a namespace', () => {
    const seen = evaluate(
      `import { ns } from './facade.js';\nout(ns.a);`,
      {
        'facade.js': `export * as ns from './base.js';`,
        'base.js': `export const a = 'in ns';`,
      },
    );
    expect(seen).toEqual(['in ns']);
  });

  it('injects extras into every module of the graph, not just the entry', () => {
    const seen = evaluate(
      `import './dep.js';\nout('entry sees out');`,
      { 'dep.js': `out('dep sees out');` },
    );
    expect(seen).toEqual(['dep sees out', 'entry sees out']);
  });

  it('keeps multi-line import statements on their original line count', () => {
    const entry =
      `import {\n  a,\n  b,\n} from './lib.js';\n` +
      `try { throw new Error('here'); } catch (e) { out(e.stack ?? ''); }`;
    const linked = linkEntry({
      source: entry,
      read: (path) => (path === 'lib.js' ? 'export const a = 1, b = 2;' : null),
    });
    if (!linked.ok) throw new Error(linked.problems.join('; '));
    const body = linked.modules.find((m) => m.path === '')?.body ?? '';
    expect(body.split('\n').length).toBe(entry.split('\n').length);
  });
});

describe('what is left alone', () => {
  it('does not rewrite import-shaped lines inside template literals', () => {
    const seen = evaluate(
      'const s = `\nimport x from \'./missing.js\'\n`;\nout(s.includes("import"));',
    );
    expect(seen).toEqual([true]);
  });

  it('does not rewrite import-shaped lines inside strings or comments', () => {
    const seen = evaluate(
      `// import a from './missing.js'\n` +
        `/* export { b } from './missing.js' */\n` +
        `const s = "import c from './missing.js'";\nout(s.length > 0);`,
    );
    expect(seen).toEqual([true]);
  });

  it('leaves member and method names called import or export alone', () => {
    const seen = evaluate(
      `const obj = { import: 1, export: 2 };\n` +
        `class K { import() { return 3; } export() { return 4; } }\n` +
        `const k = new K();\n` +
        `out(obj.import + obj.export + k.import() + k.export());`,
    );
    expect(seen).toEqual([10]);
  });

  it('reads through regex literals without losing its place', () => {
    const seen = evaluate(
      `const re = /["'\\\`{]/;\n` +
        `import { v } from './lib.js';\nout(re.test('{') && v);`,
      { 'lib.js': `export const v = true;` },
    );
    expect(seen).toEqual([true]);
  });

  it('leaves dynamic import alone, as classic evaluation always has', () => {
    const linked = linkEntry({
      source: `const load = () => import('./lazy.js');\nexport const f = load;`,
      read: () => null,
    });
    expect(linked.ok).toBe(true);
  });
});

describe('what is refused, and why', () => {
  it('refuses a bare specifier', () => {
    expect(problems(`import fs from 'node:fs';\nserve({});`).join(' ')).toMatch(
      /the entry imports "node:fs".*not a file the plugin ships/,
    );
  });

  it('refuses a missing sibling', () => {
    expect(problems(`import { x } from './gone.js';`).join(' ')).toMatch(
      /imports "gone\.js", which is not a file the plugin ships/,
    );
  });

  it('refuses a specifier that climbs out of the plugin', () => {
    expect(problems(`import { x } from '../outside.js';`).join(' ')).toMatch(
      /climbs out of the plugin/,
    );
  });

  it('refuses an import that is not a script', () => {
    expect(problems(`import data from './data.json';`).join(' ')).toMatch(
      /not a \.js\/\.mjs module/,
    );
  });

  it('refuses a cycle, naming it', () => {
    const found = problems(`import './a.js';`, {
      'a.js': `import './b.js';`,
      'b.js': `import './a.js';`,
    });
    expect(found.join(' ')).toMatch(/"b\.js" imports "a\.js" in a cycle/);
  });

  it('refuses a destructured export', () => {
    const found = problems(
      `import { a } from './lib.js';\nout(a);`,
      { 'lib.js': `export const { a } = { a: 1 };` },
    );
    expect(found.join(' ')).toMatch(
      /"lib\.js" has an export statement the portable linker cannot read/,
    );
  });

  it('refuses import.meta anywhere — classic scripts cannot parse it', () => {
    expect(
      problems(`import './a.js';`, {
        'a.js': `export function where() { return import.meta.url; }`,
      }).join(' '),
    ).toMatch(/"a\.js" uses import\.meta/);
  });

  it('collects every problem rather than stopping at the first', () => {
    const found = problems(
      `import a from 'lodash';\nimport b from './gone.js';`,
    );
    expect(found).toHaveLength(2);
  });

  it('names the entry as "the entry" and modules by path', () => {
    const found = problems(`import x from 'north';`);
    expect(found[0]).toMatch(/^the entry /);
  });
});

describe('usesModuleSyntax', () => {
  it('spots imports and re-exports at line starts', () => {
    expect(usesModuleSyntax(`import x from './y.js';`)).toBe(true);
    expect(usesModuleSyntax(`  import{a}from'./b.js'`)).toBe(true);
    expect(usesModuleSyntax(`export { a } from './b.js';`)).toBe(true);
  });

  it('stays quiet on plain scripts', () => {
    expect(usesModuleSyntax(`serve({});\nconst importer = 1;`)).toBe(false);
    expect(usesModuleSyntax(`// import x from './y.js'`)).toBe(false);
  });
});
