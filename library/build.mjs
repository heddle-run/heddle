#!/usr/bin/env node
/**
 * Pack every library entry into a `.heddle` archive.
 *
 * This is the library's test. `heddle bundle` refuses to write an archive whose
 * spec does not parse, whose graph does not hold, or that names a tool nothing
 * carries — so an entry that packs is an entry that runs, and running this in CI
 * is what stops the website listing a bundle nobody can use.
 *
 *   node library/build.mjs                 # pack all entries into library/dist
 *   node library/build.mjs --out /tmp/x    # somewhere else
 *   node library/build.mjs docs-qa         # just one
 *
 * Archives are build output, not source: library/dist is covered by the repo's
 * `dist/` ignore rule and nothing here is committed.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIBRARY_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(LIBRARY_DIR, '..');

/**
 * Fields the website reads. Missing one is a broken page, so it fails here.
 *
 * `requires` is not among them, and stays optional: most entries need nothing
 * beyond heddle itself, and an empty list in every bundle.json would be
 * ceremony. What it declares, when it declares any, travels into the archive.
 */
const REQUIRED = ['name', 'title', 'summary', 'blurb', 'tags', 'flow', 'input'];

function findCli() {
  if (process.env.HEDDLE_BIN) return process.env.HEDDLE_BIN.split(' ');

  const built = join(REPO_ROOT, 'packages/cli/dist/heddle.js');
  if (existsSync(built)) return [process.execPath, built];

  const linked = join(REPO_ROOT, 'node_modules/.bin/heddle');
  if (existsSync(linked)) return [linked];

  return ['heddle'];
}

function entryNames() {
  return readdirSync(LIBRARY_DIR)
    .filter((name) => statSync(join(LIBRARY_DIR, name)).isDirectory())
    .filter((name) => existsSync(join(LIBRARY_DIR, name, 'bundle.json')))
    .sort();
}

function readEntry(name) {
  const dir = join(LIBRARY_DIR, name);
  const manifestPath = join(dir, 'bundle.json');

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error(`${name}/bundle.json is not valid JSON: ${err.message}`);
  }

  const missing = REQUIRED.filter((field) => manifest[field] === undefined);
  if (missing.length > 0) {
    throw new Error(`${name}/bundle.json is missing: ${missing.join(', ')}`);
  }

  // The directory name is the entry's address on the website and in every
  // command in its README. Letting the two drift means a page that 404s.
  if (manifest.name !== name) {
    throw new Error(
      `${name}/bundle.json says name "${manifest.name}"; it must match the directory`,
    );
  }

  if (!existsSync(join(dir, manifest.flow))) {
    throw new Error(`${name}: no flow at ${manifest.flow}`);
  }

  return { name, dir, manifest };
}

/** The flags a hand-written `heddle bundle` for this entry would carry. */
function packArgs({ dir, manifest }, outPath) {
  const args = [join(dir, manifest.flow)];

  if (manifest.toolsDir) args.push('--tools-dir', join(dir, manifest.toolsDir));

  for (const plugin of manifest.plugins ?? []) {
    args.push('--plugin', join(dir, plugin));
  }

  // A mount is written as the CLI writes it — `src[:dest][:ro|:rw]` — so the
  // recipe in bundle.json stays readable as the command it stands in for. Only
  // the source half is rooted in the entry directory.
  for (const mount of manifest.mounts ?? []) {
    const [source, ...rest] = mount.split(':');
    args.push('--mount', [join(dir, source), ...rest].join(':'));
  }

  for (const [type, settings] of Object.entries(manifest.pluginConfig ?? {})) {
    args.push('--plugin-config', `${type}=${JSON.stringify(settings)}`);
  }

  // Passed through untouched: what an entry declares it needs is checked by
  // `heddle bundle`, so a malformed one fails this build rather than reaching
  // the recipient as a bundle that silently checks nothing.
  if (manifest.requires !== undefined) {
    args.push('--requires', JSON.stringify(manifest.requires));
  }

  args.push('--input', JSON.stringify(manifest.input));
  args.push('-o', outPath);

  return args;
}

function main() {
  const argv = process.argv.slice(2);

  let outDir = join(LIBRARY_DIR, 'dist');
  const wanted = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') outDir = resolve(argv[++i]);
    else if (argv[i].startsWith('-')) {
      console.error(`unknown flag: ${argv[i]}`);
      process.exit(2);
    } else wanted.push(argv[i]);
  }

  const names = entryNames();
  const selected = wanted.length > 0 ? wanted : names;

  const unknown = selected.filter((name) => !names.includes(name));
  if (unknown.length > 0) {
    console.error(`no such entry: ${unknown.join(', ')}`);
    console.error(`known entries: ${names.join(', ')}`);
    process.exit(2);
  }

  mkdirSync(outDir, { recursive: true });
  const cli = findCli();

  const failures = [];
  for (const name of selected) {
    const outPath = join(outDir, `${name}.heddle`);
    try {
      const entry = readEntry(name);
      execFileSync(cli[0], [...cli.slice(1), 'bundle', ...packArgs(entry, outPath)], {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'ignore', 'pipe'],
        encoding: 'utf8',
      });
      const size = (statSync(outPath).size / 1024).toFixed(0);
      console.log(`  ok    ${name.padEnd(20)} ${size} KB`);
    } catch (err) {
      const detail = (err.stderr || err.message || '').toString().trim();
      failures.push(name);
      console.log(`  FAIL  ${name}`);
      for (const line of detail.split('\n')) console.log(`        ${line}`);
    }
  }

  console.log('');
  if (failures.length > 0) {
    console.log(
      `${failures.length} of ${selected.length} entries failed: ${failures.join(', ')}`,
    );
    process.exit(1);
  }
  console.log(`${selected.length} entries packed into ${outDir}`);
}

main();
