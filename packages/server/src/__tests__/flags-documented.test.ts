/**
 * Every flag the CLI accepts has a row in the README.
 *
 * Flags get added to `parseArgs` and to `--help` in the same edit, because both
 * live in heddle-server.ts. The README is a separate file and is where an
 * operator looks when a bound they did not set starts failing their calls —
 * `--plugin-timeout` and `--llm-default-url` both shipped without one. Nothing
 * here reads the flags' meanings; it only refuses to let one exist unlisted.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..', '..');

/** The long-form flag names registered with `parseArgs`. */
function registeredFlags(): string[] {
  const source = readFileSync(join(packageRoot, 'src', 'heddle-server.ts'), 'utf-8');
  const block = /parseArgs\(\{\s*options:\s*\{([\s\S]*?)\n {4}\},/.exec(source);
  expect(block, 'the parseArgs options block moved').not.toBeNull();

  return [...block![1].matchAll(/^\s*'?([a-z][a-z-]*)'?:\s*\{/gm)].map((m) => m[1]);
}

/** The flags the README's table has a row for. */
function documentedFlags(): Set<string> {
  const readme = readFileSync(join(packageRoot, 'README.md'), 'utf-8');
  return new Set([...readme.matchAll(/^\| `--([a-z-]+)/gm)].map((m) => m[1]));
}

describe('the README flag table', () => {
  it('has a row for every flag the CLI accepts', () => {
    const documented = documentedFlags();
    // `--help` is the one exception: it is not configuration, and a table row
    // for it would tell an operator nothing the table itself does not.
    const undocumented = registeredFlags().filter(
      (flag) => flag !== 'help' && !documented.has(flag),
    );

    expect(undocumented).toEqual([]);
  });

  it('found flags to check, so an empty pass means something', () => {
    expect(registeredFlags().length).toBeGreaterThan(15);
    expect(documentedFlags().size).toBeGreaterThan(15);
  });
});
