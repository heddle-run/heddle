// Build the portable artifacts, and gate the portable graph while doing it.
//
// Two outputs, one rule. `dist/portable.js` (built by tsup beside the main
// entry) is the importable subpath for JS embedders; this script builds
// `dist/portable/heddle-engine.js`, the single evaluated-in-one-go script a
// JavaScriptCore host loads — and it builds for a *neutral* platform, so any
// `node:*` import that reaches the portable graph is a build failure here
// rather than a crash on somebody's phone. That refusal is the CI gate; do
// not "fix" it by marking node builtins external.
import { build } from 'esbuild';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));

// The engine facade when it exists; the bare barrel until it does — either
// way the whole portable graph is walked and judged.
const facade = join(root, 'src/portable-host.ts');
const entry = existsSync(facade) ? facade : join(root, 'src/portable.ts');

const outDir = join(root, 'dist/portable');
mkdirSync(outDir, { recursive: true });
const outfile = join(outDir, 'heddle-engine.js');

await build({
  entryPoints: [entry],
  bundle: true,
  outfile,
  format: 'iife',
  globalName: 'HeddleCore',
  platform: 'neutral',
  // `browser` steers the openai SDK (if present on the graph) to its
  // fetch-based shims; `worker` covers packages that key on it.
  conditions: ['browser', 'worker'],
  target: 'es2022',
  // Nothing external: the artifact is evaluated where there is no resolver.
  // The openai SDK is aliased out — the facade injects its own provider, and
  // the SDK's environment probing has no business running on a phone.
  alias: { openai: join(root, 'scripts/openai-stub.mjs') },
  define: { __HEDDLE_CORE_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'silent',
}).catch((err) => {
  for (const e of err.errors ?? []) {
    console.error(
      `portable build: ${e.text}` +
        (e.location ? ` (${e.location.file}:${e.location.line})` : ''),
    );
    if (e.text?.includes('node:') || /"(fs|path|os|crypto|child_process|zlib|url|module|stream)"/.test(e.text ?? '')) {
      console.error(
        '  A Node builtin reached the portable graph. Portable modules take ' +
          'what they need through injection — see src/portable.ts and PORTABLE.md.',
      );
    }
  }
  process.exit(1);
});

const bytes = statSync(outfile).size;
console.log(
  `portable: ${outfile.replace(root + '/', '')} (${(bytes / 1024).toFixed(0)} KiB, entry ${entry.endsWith('portable-host.ts') ? 'portable-host' : 'portable barrel only'})`,
);
