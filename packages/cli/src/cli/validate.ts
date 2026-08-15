import { Command } from 'commander';
import {
  compile,
  validate,
  loadFlow,
  collectToolNames,
  loadPlugins,
  assertToolsAvailable,
  standardRegistry,
  isBundlePath,
  PluginRegistry,
  type ParsedFlow,
} from '@heddle-run/core';
import { openBundle, type OpenedBundle } from './bundles.js';

interface ValidateOptions {
  toolsDir?: string;
  plugin?: string[];
  discoverTools?: boolean;
  format?: string;
}

export const validateCommand = new Command('validate')
  .description('Validate a Weave document')
  .argument('<flow>', 'Path to a weave.yaml (or JSON), or a .heddle bundle')
  .option('--tools-dir <dir>', 'Directory containing tool executables')
  .option(
    '--format <name>',
    'Read the document through this input format instead of resolving it ' +
      'from the file extension. "json" and "yaml" are builtin; any other ' +
      'name comes from a plugin',
  )
  .option(
    '--plugin <module>',
    'Plugin module providing custom component types (repeatable)',
    (value: string, previous: string[]) => [...previous, value],
    [] as string[],
  )
  .option(
    '--discover-tools',
    'Let a plugin that declares "discoverTools" be started so heddle can ask what tools it has. Off by default: reading a manifest runs nothing.',
  )
  .action(async (specPath: string, options: ValidateOptions) => {
    // A received bundle is the case this exists for: validating it means
    // validating what it carries, with the tools and plugins it carries.
    // `given` is what the verdict names — the file the caller typed, not the
    // temp directory it was opened into.
    const given = specPath;
    let bundle: OpenedBundle | undefined;
    if (isBundlePath(specPath)) {
      bundle = openBundle(specPath);
      specPath = bundle.flowPath;
      options.toolsDir ??= bundle.toolsDir;
      options.plugin = [...bundle.plugins, ...(options.plugin ?? [])];
    }

    const plugins = await loadPlugins(options.plugin, {
      discovery: options.discoverTools === true,
    });
    try {
      // `loadFlow` runs both passes: the document's own shape, then the
      // references, the graph and the plugin components. A flow that loads
      // is one that compiles — `validate` after `compile` is the backstop
      // over heddle's own lowering.
      const flow = loadFlow(specPath, plugins, { format: options.format });
      console.log(`  Parsed flow: ${flow.name}`);

      validate(compile(flow, { plugins }));
      console.log('  Graph validation passed');

      if (options.toolsDir || plugins.hasTools()) {
        reportToolValidation(flow, options, plugins);
      }

      console.log(`Valid: ${given}`);
    } finally {
      // The one thing that starts a process on this path is discovery, and it
      // is the reason this exists: a spawned plugin's piped stdio keeps the
      // event loop referenced, so `heddle validate --discover-tools` printed
      // "Valid" and then never exited. `run.ts` has always disposed in a
      // `finally`; this path had nothing to dispose until now.
      plugins.dispose();
      bundle?.dispose();
    }
  });

function reportToolValidation(
  flow: ParsedFlow,
  options: ValidateOptions,
  plugins: PluginRegistry,
): void {
  const toolNames = collectToolNames(flow);
  if (toolNames.length === 0) {
    console.log('  No tools to validate');
    return;
  }

  const registry = standardRegistry({ plugins, toolsDir: options.toolsDir });
  assertToolsAvailable(registry, toolNames);

  console.log(`  Tool validation passed (${toolNames.length} tools found)`);
}
