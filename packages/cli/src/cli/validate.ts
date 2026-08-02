import { Command } from 'commander';
import {
  compile,
  validate,
  loadFlow,
  loadComponent,
  collectToolNames,
  loadPlugins,
  messageOf,
  assertToolsAvailable,
  standardRegistry,
  isBundlePath,
  PluginRegistry,
  type CompiledGraph,
  type ParsedFlow,
} from '@heddle/core';
import { openBundle, type OpenedBundle } from './bundles.js';

interface ValidateOptions {
  toolsDir?: string;
  plugin?: string[];
  discoverTools?: boolean;
  format?: string;
}

export const validateCommand = new Command('validate')
  .description('Validate an Agent Spec component (Flow, Agent, Swarm, etc.)')
  .argument('<spec>', 'Path to spec JSON or YAML file, or a .heddle bundle')
  .option('--tools-dir <dir>', 'Directory containing tool executables')
  .option(
    '--format <name>',
    'Read the spec through this input format instead of resolving it from ' +
      'the file extension. "json" and "yaml" are builtin; any other name ' +
      'comes from a plugin',
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
      const component = loadComponent(specPath, plugins, {
        format: options.format,
      }) as unknown as {
        componentType: string;
        name: string;
      };
      console.log(`  Parsed ${component.componentType}: ${component.name}`);

      if (component.componentType === 'Flow') {
        validateFlowFile(specPath, options, plugins);
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

function validateFlowFile(
  specPath: string,
  options: ValidateOptions,
  plugins: PluginRegistry,
): void {
  const flow = loadFlow(specPath, plugins, { format: options.format });

  reportGraphValidation(flow, plugins);

  if (options.toolsDir || plugins.hasTools()) {
    reportToolValidation(flow, options, plugins);
  }
}

/**
 * Check the graph, and tell a graph that is wrong from one that was not read.
 *
 * Only compilation is tolerated here. It is the half that can fail for reasons
 * that are not the flow's fault — a node type whose plugin is not loaded is the
 * usual one — and reporting a check that could not run as a fault would refuse
 * specs that are fine. Validation is the other half: the graph compiled, heddle
 * read it, and what it found is a verdict. That throws, and the exit status
 * carries it, because a validator that prints a fatal problem and exits 0 is
 * one nobody can put in CI.
 */
function reportGraphValidation(
  flow: ParsedFlow,
  plugins: PluginRegistry,
): void {
  let graph: CompiledGraph;
  try {
    graph = compile(flow, { plugins });
  } catch (err) {
    console.log(`  Graph validation skipped: ${messageOf(err)}`);
    return;
  }

  validate(graph);
  console.log('  Graph validation passed');
}

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
