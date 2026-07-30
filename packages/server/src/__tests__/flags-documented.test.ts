import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..', '..');

const UNDOCUMENTED_BY_DESIGN = new Set(['help']);
const MINIMUM_FLAGS = 15;

function registeredFlags(): string[] {
  const source = readFileSync(
    join(packageRoot, 'src', 'heddle-server.ts'),
    'utf-8',
  );
  const block = /parseArgs\(\{\s*options:\s*\{([\s\S]*?)\n {4}\},/.exec(source);
  expect(block, 'the parseArgs options block moved').not.toBeNull();

  return [...block![1].matchAll(/^\s*'?([a-z][a-z-]*)'?:\s*\{/gm)].map(
    (match) => match[1],
  );
}

function documentedFlags(): Set<string> {
  const readme = readFileSync(join(packageRoot, 'README.md'), 'utf-8');
  return new Set(
    [...readme.matchAll(/^\| `--([a-z-]+)/gm)].map((match) => match[1]),
  );
}

describe('the README flag table', () => {
  it('has a row for every flag the CLI accepts', () => {
    const documented = documentedFlags();
    const undocumented = registeredFlags().filter(
      (flag) => !UNDOCUMENTED_BY_DESIGN.has(flag) && !documented.has(flag),
    );

    expect(undocumented).toEqual([]);
  });

  it('found flags to check, so an empty pass means something', () => {
    expect(registeredFlags().length).toBeGreaterThan(MINIMUM_FLAGS);
    expect(documentedFlags().size).toBeGreaterThan(MINIMUM_FLAGS);
  });
});
