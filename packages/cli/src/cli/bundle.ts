import { basename, extname } from 'node:path';
import { Command } from 'commander';
import {
  BundleError,
  collectToolNames,
  compile,
  composeRegistries,
  FileRegistry,
  isBundlePath,
  loadFlow,
  loadPlugins,
  missingTools,
  packBundle,
  parseMount,
  parsePluginConfig,
  requirementLabel,
  validate,
  BUNDLE_EXTENSION,
  type BundlePlan,
  type PackedBundle,
  type ParsedFlow,
  type PluginRegistry,
} from '@heddle-run/core';
import { readRequiresOption } from './bundles.js';

interface BundleOptions {
  toolsDir?: string;
  plugin: string[];
  discoverTools?: boolean;
  pluginConfig: string[];
  mount: string[];
  input?: string;
  requires?: string;
  interactive?: boolean;
  output?: string;
}

export const bundleCommand = new Command('bundle')
  .description(
    'Pack a flow and everything it runs with into one shareable ' +
      `${BUNDLE_EXTENSION} archive, runnable anywhere with "heddle run"`,
  )
  .argument('<flow>', 'Path to flow JSON or YAML file')
  .option('--tools-dir <dir>', 'Directory containing tool executables to ship')
  .option(
    '--plugin <manifest>',
    'Plugin to ship, as a .json manifest — its whole directory travels ' +
      '(repeatable)',
    collect,
    [] as string[],
  )
  .option(
    '--discover-tools',
    'Let a plugin that declares "discoverTools" be started so the bundle can ' +
      'be checked against its tools. Off by default: reading a manifest runs ' +
      'nothing.',
  )
  .option(
    '--plugin-config <type=json>',
    'Component settings recorded in the bundle; value may be inline JSON or ' +
      '@file, and a @file is read now so only its contents travel (repeatable)',
    collect,
    [] as string[],
  )
  .option(
    '--mount <src[:dest][:ro|:rw]>',
    'File or directory to ship, landing in every workspace where a --mount ' +
      'would put it (repeatable)',
    collect,
    [] as string[],
  )
  .option(
    '--input <json>',
    'Default input recorded in the bundle; "heddle run --input" overrides it',
  )
  .option(
    '--requires <json|@file>',
    'What the machine running this must already have, as a JSON list of ' +
      '{"binary"|"env"|"file"|"node": …, "hint": …} entries. Checked before a ' +
      'run starts and reported all at once; never installed, fetched or run',
  )
  .option(
    '--interactive',
    'Record that this bundle would rather open the chat UI than run once. ' +
      '"heddle run" honours it at a terminal; scripts, pipes and an explicit ' +
      '--input still run once',
  )
  .option(
    '-o, --output <file>',
    `Where to write the bundle (default: <flow name>${BUNDLE_EXTENSION})`,
  )
  .action(async (flowPath: string, options: BundleOptions) => {
    assertBundleable(flowPath, options);

    const plugins = await loadPlugins(options.plugin, {
      discovery: options.discoverTools === true,
    });

    let flow: ParsedFlow;
    try {
      // The full gate a run applies, minus running: a bundle is a promise
      // that "heddle run <this>" works, so anything that would fail there —
      // a spec that does not parse, a graph that does not hold, a tool the
      // flow names and nothing provides — fails here, before it is shipped.
      flow = loadFlow(flowPath, plugins);
      validate(compile(flow, { plugins }));
      assertToolsCarried(flow, options, plugins);
    } finally {
      plugins.dispose();
    }

    const plan: BundlePlan = {
      name: flow.name,
      flowPath,
      toolsDir: options.toolsDir,
      pluginManifests: options.plugin,
      pluginConfig: parsePluginConfig(options.pluginConfig),
      mounts: options.mount.map(parseMount),
      input: parseDefaultInput(options.input),
      // Read here rather than only at unpack time, so a typo in a declaration
      // is caught on the machine that can fix it instead of the one that was
      // sent the bundle.
      requires: readRequiresOption(options.requires),
      interactive: options.interactive,
    };

    const outPath = options.output ?? defaultOutput(flow.name, flowPath);
    report(packBundle(plan, outPath), plan);
  });

/**
 * The refusals that need no file read at all.
 *
 * An in-process plugin is the load-bearing one. It is an importable module —
 * it may reach node_modules, another package, anything on this machine — so
 * its closure is not something a directory walk can collect, and a bundle
 * that shipped only its entry file would run here and nowhere else. A
 * manifest plugin's confinement rule is exactly what makes it bundleable.
 */
function assertBundleable(flowPath: string, options: BundleOptions): void {
  if (isBundlePath(flowPath)) {
    throw new BundleError(
      `"${flowPath}" is already a bundle. "heddle bundle" packs a flow file; ` +
        `to change what a bundle carries, rebuild it from its sources.`,
    );
  }

  const inProcess = options.plugin.filter(
    (specifier) => !specifier.endsWith('.json'),
  );
  if (inProcess.length > 0) {
    throw new BundleError(
      `${inProcess.map((p) => `"${p}"`).join(', ')} ` +
        `${inProcess.length === 1 ? 'is' : 'are'} not a .json plugin manifest. ` +
        `An in-process plugin is an importable module, and what it imports ` +
        `lives on this machine — a bundle cannot carry its closure. A manifest ` +
        `plugin is confined to its own directory, which is what makes it ` +
        `shippable: give the plugin a manifest, and bundle that.`,
    );
  }
}

function assertToolsCarried(
  flow: ParsedFlow,
  options: BundleOptions,
  plugins: PluginRegistry,
): void {
  const names = collectToolNames(flow);
  if (names.length === 0) return;

  const registry = composeRegistries([
    plugins.toolRegistry(),
    FileRegistry.create(options.toolsDir ?? ''),
  ]);

  const missing = missingTools(registry, names);
  if (missing.length > 0) {
    throw new BundleError(
      `the flow names tools the bundle would not carry: ${missing.join(', ')}. ` +
        `Ship them with --tools-dir or a --plugin — a bundle that leaves one ` +
        `out fails on whoever receives it.`,
    );
  }
}

function parseDefaultInput(
  raw: string | undefined,
): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new BundleError('failed to parse --input JSON', { cause: err });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BundleError('--input must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Named for the flow, not the file: `flow.json` and `spec.yaml` are what flow
 * files are actually called, and a directory of bundles all named
 * `flow.heddle` tells nobody anything.
 */
function defaultOutput(flowName: string, flowPath: string): string {
  const safe = flowName.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const fallback = basename(flowPath, extname(flowPath));
  return `${safe.length > 0 ? safe : fallback}${BUNDLE_EXTENSION}`;
}

function report(packed: PackedBundle, plan: BundlePlan): void {
  console.log(`  Flow: ${plan.name} (${basename(plan.flowPath)})`);
  if (plan.toolsDir !== undefined) {
    console.log(`  Tools: ${plan.toolsDir}`);
  }
  if (packed.plugins.length > 0) {
    console.log(`  Plugins: ${packed.plugins.join(', ')}`);
  }
  if (plan.mounts.length > 0) {
    console.log(
      `  Mounts: ${plan.mounts.map((m) => `${m.dest} (${m.mode})`).join(', ')}`,
    );
  }
  if (plan.input !== undefined) {
    console.log('  Default input: recorded');
  }
  // Said out loud at pack time, because this is the field an author cannot
  // otherwise tell went in — and the one whose absence the recipient pays for.
  if (plan.requires?.length) {
    console.log(`  Requires: ${plan.requires.map(requirementLabel).join(', ')}`);
  }
  console.log(
    `Wrote ${packed.path} (${size(packed.bytes)}, ${packed.entries} entries)`,
  );
  console.log(`Run it anywhere with: heddle run ${packed.path}`);
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(1)} MiB`;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
