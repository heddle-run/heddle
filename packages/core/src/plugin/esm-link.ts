/**
 * Linking a plugin's ES modules for a host with no module loader.
 *
 * A portable host evaluates plugin entries as classic scripts — there is no
 * loader to hand `import` statements to. This module closes that gap for the
 * common case: a plugin whose entry imports its own sibling files. The graph
 * is walked from the entry, every static `import`/`export` declaration is
 * rewritten onto two injected locals (`__heddle_import`, `__heddle_exports`),
 * and the modules come back in dependency order for {@link evaluateLinked} to
 * run one classic evaluation each.
 *
 * The scanner is deliberately conservative, because the same walk backs
 * `checkPortability`: a shape it cannot read — a bare specifier, a
 * destructured export, a cycle — is a *problem*, and a problem makes the
 * bundle non-portable. A false refusal costs a fallback to a host with a
 * real loader; a wrong rewrite would corrupt a run, so nothing is rewritten
 * unless it parsed completely. Two semantic edges are knowingly narrower
 * than a real loader and are fine for plugin code: imported bindings are
 * snapshots, not live bindings, and import declarations are not hoisted
 * above earlier top-level statements.
 */

/** One module of a linked graph, ready for {@link evaluateLinked}. */
export interface LinkedModule {
  /** Plugin-dir-relative path, `/`-separated; the entry is {@link ENTRY_PATH}. */
  path: string;
  /**
   * The rewritten source: a classic-script body whose scope must provide
   * `__heddle_import(path)` and `__heddle_exports`.
   */
  body: string;
}

export type LinkResult =
  | { ok: true; modules: LinkedModule[] }
  | { ok: false; problems: string[] };

/** How the entry names itself in a graph — it has no path of its own. */
export const ENTRY_PATH = '';

/** Enough modules for any plugin; a backstop, not a budget. */
const MAX_MODULES = 64;

/**
 * Top-level ESM syntax, found by shape rather than by parsing — the cheap
 * pre-question "does this entry need linking at all?". A false positive only
 * sends the source through the real scanner below, which settles it.
 */
const MODULE_SYNTAX = /^\s*(import[\s"'{*]|export\s+.*\bfrom\b)/;

export function usesModuleSyntax(source: string): boolean {
  return source.split('\n').some((line) => MODULE_SYNTAX.test(line));
}

export interface LinkEntryOptions {
  /** The entry's source text. */
  source: string;
  /** Read a module by plugin-dir-relative path; `null` when it is not there. */
  read: (path: string) => string | null;
}

/**
 * Walk the entry's import graph and rewrite every module.
 *
 * All problems are collected rather than thrown, because the caller judging
 * portability wants every reason, not the first one.
 */
export function linkEntry(options: LinkEntryOptions): LinkResult {
  const modules: LinkedModule[] = [];
  const problems: string[] = [];
  const state = new Map<string, 'linking' | 'done'>();

  const visit = (path: string, source: string): void => {
    state.set(path, 'linking');
    const label = path === ENTRY_PATH ? 'the entry' : `"${path}"`;
    const transformed = transformModule(source, dirOf(path));
    problems.push(...transformed.problems.map((p) => `${label} ${p}`));

    for (const dep of transformed.deps) {
      const seen = state.get(dep);
      if (seen === 'done') continue;
      if (seen === 'linking') {
        problems.push(
          `${label} imports "${dep}" in a cycle, which the portable linker ` +
            `does not order`,
        );
        continue;
      }
      if (state.size > MAX_MODULES) {
        problems.push(
          `${label} grows the import graph past ${MAX_MODULES} modules`,
        );
        continue;
      }
      const depSource = options.read(dep);
      if (depSource === null) {
        problems.push(
          `${label} imports "${dep}", which is not a file the plugin ships`,
        );
        continue;
      }
      visit(dep, depSource);
    }

    state.set(path, 'done');
    modules.push({ path, body: transformed.body });
  };

  visit(ENTRY_PATH, options.source);

  return problems.length > 0
    ? { ok: false, problems: [...new Set(problems)] }
    : { ok: true, modules };
}

/**
 * Evaluate a linked graph, one classic-script evaluation per module in
 * dependency order, with `extras` (a portable host's `serve`, say) injected
 * into every module's scope the way the stdio runtime's globals would be.
 * Bodies run strict, as real modules do.
 */
export function evaluateLinked(
  modules: LinkedModule[],
  extras: Record<string, unknown> = {},
): void {
  const exportsByPath = new Map<string, Record<string, unknown>>();
  const importOf = (path: string): Record<string, unknown> => {
    const found = exportsByPath.get(path);
    if (!found) {
      // Unreachable off a graph this module built: deps evaluate first.
      throw new Error(`module "${path}" was imported before it was linked`);
    }
    return found;
  };

  const names = Object.keys(extras);
  const values = names.map((name) => extras[name]);
  for (const module of modules) {
    const exports: Record<string, unknown> = {};
    exportsByPath.set(module.path, exports);
    new Function(
      ...names,
      '__heddle_import',
      '__heddle_exports',
      `"use strict";${module.body}`,
    )(...values, importOf, exports);
  }
}

// ---------------------------------------------------------------------------
// One module's rewrite.

interface TransformResult {
  body: string;
  /** Resolved module paths this module imports, in source order. */
  deps: string[];
  /** Why the module cannot be linked; phrased to follow the module's name. */
  problems: string[];
}

interface Edit {
  start: number;
  end: number;
  code: string;
}

/** Idents that begin a statement no declaration scan should run into. */
const STATEMENT_KEYWORDS = new Set([
  'import',
  'export',
  'const',
  'let',
  'var',
  'function',
  'class',
]);

function transformModule(source: string, dir: string): TransformResult {
  const tokens = lex(source);
  const deps: string[] = [];
  const problems: string[] = [];
  const edits: Edit[] = [];
  const trailing: string[] = [];

  const resolveSpec = (spec: string): string | undefined => {
    const resolved = resolvePath(dir, spec);
    if ('problem' in resolved) {
      problems.push(resolved.problem);
      return undefined;
    }
    if (!deps.includes(resolved.path)) deps.push(resolved.path);
    return resolved.path;
  };

  const cursor = new TokenCursor(tokens);
  for (;;) {
    const preceding = cursor.previous();
    const token = cursor.next();
    if (!token) break;
    if (token.type !== 'ident') continue;
    if (token.text !== 'import' && token.text !== 'export') continue;

    if (preceding?.type === 'punct' && preceding.text === '.') continue;

    const after = cursor.peek();
    if (token.text === 'import' && after?.type === 'punct' && after.text === '.') {
      // `import.meta` is a parse error in any classic script, linked or not.
      problems.push('uses import.meta, which only a module loader defines');
      continue;
    }
    if (token.depth > 0) continue;
    if (after?.type === 'punct' && after.text === '(') {
      // Dynamic import: legal syntax in a classic script, refused only if it
      // actually runs — the same footing a single-file entry has today.
      continue;
    }

    const parsed =
      token.text === 'import'
        ? parseImport(token, cursor, resolveSpec)
        : parseExport(token, cursor, resolveSpec, trailing);
    if (parsed === 'malformed') {
      problems.push(
        `has an ${token.text} statement the portable linker cannot read`,
      );
    } else if (parsed) {
      edits.push(parsed);
    }
  }

  return { body: applyEdits(source, edits, trailing), deps, problems };
}

/** Rewrites, applied; newlines preserved so error lines still point home. */
function applyEdits(source: string, edits: Edit[], trailing: string[]): string {
  let body = '';
  let at = 0;
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    body += source.slice(at, edit.start);
    body += edit.code;
    const dropped = source.slice(edit.start, edit.end);
    body += '\n'.repeat(dropped.split('\n').length - 1);
    at = edit.end;
  }
  body += source.slice(at);
  for (const line of trailing) body += `\n${line}`;
  return body;
}

function quote(path: string): string {
  return JSON.stringify(path);
}

/**
 * `import …` at the top level. Returns the rewrite, `undefined` when the
 * statement parsed but its specifier was refused (the problem is already
 * filed), or `'malformed'` when the shape itself could not be read.
 */
function parseImport(
  start: Token,
  cursor: TokenCursor,
  resolveSpec: (spec: string) => string | undefined,
): Edit | undefined | 'malformed' {
  let token = cursor.next();
  if (!token) return 'malformed';

  // import "./side-effect.js";
  if (token.type === 'string') {
    const path = resolveSpec(token.value ?? '');
    const end = endOfStatement(cursor, token);
    if (path === undefined) return undefined;
    return { start: start.start, end, code: `__heddle_import(${quote(path)});` };
  }

  const named: Array<{ imported: string; local: string }> = [];
  let star: string | undefined;

  if (token.type === 'ident') {
    named.push({ imported: 'default', local: token.text });
    if (isPunct(cursor.peek(), ',')) cursor.next();
    token = cursor.next();
    if (!token) return 'malformed';
  }

  if (token.type === 'punct' && token.text === '*') {
    if (!cursor.nextIsIdent('as')) return 'malformed';
    const local = cursor.next();
    if (local?.type !== 'ident') return 'malformed';
    star = local.text;
    token = cursor.next();
    if (!token) return 'malformed';
  } else if (token.type === 'punct' && token.text === '{') {
    for (;;) {
      const name = cursor.next();
      if (!name) return 'malformed';
      if (name.type === 'punct' && name.text === '}') break;
      if (name.type !== 'ident') return 'malformed';
      let local = name.text;
      if (cursor.peekIsIdent('as')) {
        cursor.next();
        const alias = cursor.next();
        if (alias?.type !== 'ident') return 'malformed';
        local = alias.text;
      }
      named.push({ imported: name.text, local });
      const sep = cursor.next();
      if (!sep) return 'malformed';
      if (sep.type === 'punct' && sep.text === '}') break;
      if (!(sep.type === 'punct' && sep.text === ',')) return 'malformed';
    }
    token = cursor.next();
    if (!token) return 'malformed';
  }

  if (!(token.type === 'ident' && token.text === 'from')) return 'malformed';
  const spec = cursor.next();
  if (spec?.type !== 'string') return 'malformed';

  const path = resolveSpec(spec.value ?? '');
  const end = endOfStatement(cursor, spec);
  if (path === undefined) return undefined;

  const pieces: string[] = [];
  if (star) pieces.push(`const ${star} = __heddle_import(${quote(path)});`);
  if (named.length > 0) {
    const bindings = named
      .map((entry) => `${entry.imported}: ${entry.local}`)
      .join(', ');
    pieces.push(`const { ${bindings} } = __heddle_import(${quote(path)});`);
  }
  if (pieces.length === 0) pieces.push(`__heddle_import(${quote(path)});`);
  return { start: start.start, end, code: pieces.join(' ') };
}

/** `export …` at the top level; see {@link parseImport} for the returns. */
function parseExport(
  start: Token,
  cursor: TokenCursor,
  resolveSpec: (spec: string) => string | undefined,
  trailing: string[],
): Edit | undefined | 'malformed' {
  const token = cursor.next();
  if (!token) return 'malformed';

  // export default <expression | function | class>
  if (token.type === 'ident' && token.text === 'default') {
    return {
      start: start.start,
      end: token.end,
      code: '__heddle_exports.default =',
    };
  }

  // export { a, b as c }  /  export { a } from "./m.js"
  if (token.type === 'punct' && token.text === '{') {
    const entries: Array<{ local: string; exported: string }> = [];
    for (;;) {
      const name = cursor.next();
      if (!name) return 'malformed';
      if (name.type === 'punct' && name.text === '}') break;
      if (name.type !== 'ident') return 'malformed';
      let exported = name.text;
      if (cursor.peekIsIdent('as')) {
        cursor.next();
        const alias = cursor.next();
        if (alias?.type !== 'ident') return 'malformed';
        exported = alias.text;
      }
      entries.push({ local: name.text, exported });
      const sep = cursor.next();
      if (!sep) return 'malformed';
      if (sep.type === 'punct' && sep.text === '}') break;
      if (!(sep.type === 'punct' && sep.text === ',')) return 'malformed';
    }

    if (cursor.peekIsIdent('from')) {
      cursor.next();
      const spec = cursor.next();
      if (spec?.type !== 'string') return 'malformed';
      const path = resolveSpec(spec.value ?? '');
      const end = endOfStatement(cursor, spec);
      if (path === undefined) return undefined;
      const copies = entries
        .map((e) => `__heddle_exports.${e.exported} = __m.${e.local};`)
        .join(' ');
      return {
        start: start.start,
        end,
        code: `{ const __m = __heddle_import(${quote(path)}); ${copies} }`,
      };
    }

    const end = endOfStatement(cursor, cursor.previous() ?? token);
    for (const entry of entries) {
      trailing.push(`__heddle_exports.${entry.exported} = ${entry.local};`);
    }
    return { start: start.start, end, code: '' };
  }

  // export * from "./m.js"  /  export * as ns from "./m.js"
  if (token.type === 'punct' && token.text === '*') {
    let ns: string | undefined;
    if (cursor.peekIsIdent('as')) {
      cursor.next();
      const alias = cursor.next();
      if (alias?.type !== 'ident') return 'malformed';
      ns = alias.text;
    }
    if (!cursor.nextIsIdent('from')) return 'malformed';
    const spec = cursor.next();
    if (spec?.type !== 'string') return 'malformed';
    const path = resolveSpec(spec.value ?? '');
    const end = endOfStatement(cursor, spec);
    if (path === undefined) return undefined;
    if (ns) {
      return {
        start: start.start,
        end,
        code: `__heddle_exports.${ns} = __heddle_import(${quote(path)});`,
      };
    }
    // A star re-export, minus `default`, exactly as a loader would — except
    // that a name exported twice resolves last-wins here where a loader
    // would refuse the ambiguity.
    return {
      start: start.start,
      end,
      code:
        `{ const __m = __heddle_import(${quote(path)}); ` +
        `for (const __k of Object.keys(__m)) ` +
        `if (__k !== "default") __heddle_exports[__k] = __m[__k]; }`,
    };
  }

  // export function f / export class C / export async function f
  if (
    token.type === 'ident' &&
    (token.text === 'function' ||
      token.text === 'class' ||
      token.text === 'async')
  ) {
    if (token.text === 'async' && !cursor.nextIsIdent('function')) {
      return 'malformed';
    }
    if (isPunct(cursor.peek(), '*')) cursor.next();
    const name = cursor.next();
    if (name?.type !== 'ident') return 'malformed'; // anonymous: default-only
    trailing.push(`__heddle_exports.${name.text} = ${name.text};`);
    return { start: start.start, end: token.start, code: '' };
  }

  // export const a = …, b = …  (let / var alike)
  if (
    token.type === 'ident' &&
    (token.text === 'const' || token.text === 'let' || token.text === 'var')
  ) {
    for (;;) {
      const name = cursor.next();
      if (name?.type !== 'ident') return 'malformed'; // destructuring, etc.
      trailing.push(`__heddle_exports.${name.text} = ${name.text};`);
      if (!skipToNextDeclarator(cursor)) break;
    }
    return { start: start.start, end: token.start, code: '' };
  }

  return 'malformed';
}

/**
 * Consume an exported declarator's initializer; `true` when a `,` at the
 * declaration's own level says another declarator follows. Stops at `;`, at
 * a token that can only start the next statement, or at the end.
 */
function skipToNextDeclarator(cursor: TokenCursor): boolean {
  for (;;) {
    const token = cursor.peek();
    if (!token) return false;
    if (token.depth === 0) {
      if (token.type === 'punct' && token.text === ';') {
        cursor.next();
        return false;
      }
      if (token.type === 'punct' && token.text === ',') {
        cursor.next();
        return true;
      }
      if (token.type === 'ident' && STATEMENT_KEYWORDS.has(token.text)) {
        return false;
      }
    }
    cursor.next();
  }
}

/** Consume a trailing `;` when it is next; the statement's end offset. */
function endOfStatement(cursor: TokenCursor, last: Token): number {
  const token = cursor.peek();
  if (token?.type === 'punct' && token.text === ';') {
    cursor.next();
    return token.end;
  }
  return last.end;
}

function isPunct(token: Token | undefined, ...texts: string[]): boolean {
  return token?.type === 'punct' && texts.includes(token.text);
}

// ---------------------------------------------------------------------------
// Specifier resolution: relative, inside the plugin, script extensions only.

function dirOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

function resolvePath(
  dir: string,
  spec: string,
): { path: string } | { problem: string } {
  if (spec.includes('\\')) {
    return { problem: `imports "${spec}", which is not a /-separated path` };
  }
  if (!spec.startsWith('./') && !spec.startsWith('../')) {
    return {
      problem:
        `imports "${spec}", which is not a file the plugin ships — only ` +
        `relative imports can be linked without a module loader`,
    };
  }

  const segments = dir === '' ? [] : dir.split('/');
  for (const part of spec.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (segments.length === 0) {
        return {
          problem: `imports "${spec}", which climbs out of the plugin's directory`,
        };
      }
      segments.pop();
      continue;
    }
    segments.push(part);
  }

  const path = segments.join('/');
  if (!path.endsWith('.js') && !path.endsWith('.mjs')) {
    return {
      problem: `imports "${spec}", which is not a .js/.mjs module`,
    };
  }
  return { path };
}

// ---------------------------------------------------------------------------
// The scanner: just enough of a JavaScript lexer to know which `import` and
// `export` words are code rather than a string, a comment, or a member name,
// and how deeply nested each token sits. Where JavaScript is genuinely
// ambiguous to a lexer — `/` as division or regex — it guesses the way
// parsers' fast paths do; a wrong guess surfaces as a parse problem and a
// refusal, never as a silent rewrite.

interface Token {
  type: 'ident' | 'number' | 'string' | 'punct' | 'template' | 'regex';
  start: number;
  end: number;
  text: string;
  /** Decoded value, for strings. */
  value?: string;
  /** Combined nesting — braces, brackets, parens, template holes — at start. */
  depth: number;
}

/** Idents after which `/` begins a regex, not division. */
const OPERAND_EXPECTED = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_$]/.test(ch) || ch.charCodeAt(0) > 127;
}

function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch) || ch.charCodeAt(0) > 127;
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  // Each `${` opens a hole: code inside a template. `braces` counts `{` seen
  // inside the current hole, so the `}` that closes the hole is known.
  const holes: number[] = [];
  let depth = 0;
  let i = 0;

  const last = (): Token | undefined => tokens[tokens.length - 1];

  const push = (type: Token['type'], start: number, value?: string): void => {
    tokens.push({
      type,
      start,
      end: i,
      text: source.slice(start, i),
      ...(value === undefined ? {} : { value }),
      depth: 0, // patched below; depth is measured before open, after close
    });
  };

  const readString = (quoteChar: string): string => {
    let value = '';
    while (i < source.length) {
      const ch = source[i];
      if (ch === '\\') {
        const next = source[i + 1];
        value += next === 'n' ? '\n' : next === 't' ? '\t' : (next ?? '');
        i += 2;
        continue;
      }
      if (ch === quoteChar || ch === '\n') break;
      value += ch;
      i += 1;
    }
    if (source[i] === quoteChar) i += 1;
    return value;
  };

  const readTemplate = (): 'closed' | 'hole' => {
    while (i < source.length) {
      const ch = source[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '`') {
        i += 1;
        return 'closed';
      }
      if (ch === '$' && source[i + 1] === '{') {
        i += 2;
        return 'hole';
      }
      i += 1;
    }
    return 'closed';
  };

  const regexAllowed = (): boolean => {
    const prev = last();
    if (!prev) return true;
    if (prev.type === 'ident') return OPERAND_EXPECTED.has(prev.text);
    if (prev.type === 'punct') return !')]'.includes(prev.text);
    return false; // number, string, template, regex: division
  };

  const readRegex = (): void => {
    let inClass = false;
    while (i < source.length) {
      const ch = source[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '\n') break;
      i += 1;
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) break;
    }
    while (i < source.length && isIdentPart(source[i])) i += 1;
  };

  while (i < source.length) {
    const ch = source[i];
    const start = i;

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f') {
      i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      i = close === -1 ? source.length : close + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i += 1;
      const value = readString(ch);
      push('string', start, value);
      last()!.depth = depth;
      continue;
    }
    if (ch === '`') {
      i += 1;
      if (readTemplate() === 'hole') {
        holes.push(0);
        depth += 1;
        continue;
      }
      push('template', start);
      last()!.depth = depth;
      continue;
    }
    if (ch === '/' && regexAllowed()) {
      i += 1;
      readRegex();
      push('regex', start);
      last()!.depth = depth;
      continue;
    }
    if (isIdentStart(ch)) {
      i += 1;
      while (i < source.length && isIdentPart(source[i])) i += 1;
      push('ident', start);
      last()!.depth = depth;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      i += 1;
      while (i < source.length && /[A-Za-z0-9_.]/.test(source[i])) i += 1;
      push('number', start);
      last()!.depth = depth;
      continue;
    }

    // Punctuation, one significant character at a time.
    i += 1;
    if (ch === '{' || ch === '(' || ch === '[') {
      push('punct', start);
      last()!.depth = depth;
      depth += 1;
      if (ch === '{' && holes.length > 0) holes[holes.length - 1] += 1;
      continue;
    }
    if (ch === '}' && holes.length > 0 && holes[holes.length - 1] === 0) {
      // The `}` that closes a `${` hole: back into template text.
      holes.pop();
      depth = Math.max(0, depth - 1);
      if (readTemplate() === 'hole') {
        holes.push(0);
        depth += 1;
      } else {
        push('template', start);
        last()!.depth = depth;
      }
      continue;
    }
    if (ch === '}' || ch === ')' || ch === ']') {
      depth = Math.max(0, depth - 1);
      if (ch === '}' && holes.length > 0) {
        holes[holes.length - 1] = Math.max(0, holes[holes.length - 1] - 1);
      }
      push('punct', start);
      last()!.depth = depth;
      continue;
    }
    push('punct', start);
    last()!.depth = depth;
  }

  return tokens;
}

/** A forward walk over the token list, with lookahead and one look back. */
class TokenCursor {
  private at = 0;

  constructor(private readonly tokens: Token[]) {}

  next(): Token | undefined {
    return this.tokens[this.at++];
  }

  peek(): Token | undefined {
    return this.tokens[this.at];
  }

  /** The most recently consumed token. */
  previous(): Token | undefined {
    return this.tokens[this.at - 1];
  }

  peekIsIdent(text: string): boolean {
    const token = this.peek();
    return token?.type === 'ident' && token.text === text;
  }

  nextIsIdent(text: string): boolean {
    const token = this.next();
    return token?.type === 'ident' && token.text === text;
  }
}
