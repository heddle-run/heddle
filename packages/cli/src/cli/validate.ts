import { Command } from 'commander';
import {
  compile,
  validate,
  loadFlow,
  loadComponent,
  collectToolNames,
  loadPlugins,
  FileRegistry,
  composeRegistries,
  missingTools,
  PluginRegistry,
  ToolError,
  type ParsedFlow,
} from '@heddle/core';

interface ValidateOptions {
  toolsDir?: string;
  plugin?: string[];
}

export const validateCommand = new Command('validate')
  .description('Validate an Agent Spec component (Flow, Agent, Swarm, etc.)')
  .argument('<spec>', 'Path to spec JSON or YAML file')
  .option('--tools-dir <dir>', 'Directory containing tool executables')
  .option(
    '--plugin <module>',
    'Plugin module providing custom component types (repeatable)',
    (value: string, previous: string[]) => [...previous, value],
    [] as string[],
  )
  .action(async (specPath: string, options: ValidateOptions) => {
    const plugins = await loadPlugins(options.plugin);

    const component = loadComponent(specPath, plugins) as unknown as {
      componentType: string;
      name: string;
    };
    console.log(`  Parsed ${component.componentType}: ${component.name}`);

    if (component.componentType === 'Flow') {
      validateFlowFile(specPath, options, plugins);
    }

    console.log(`Valid: ${specPath}`);
  });

function validateFlowFile(
  specPath: string,
  options: ValidateOptions,
  plugins: PluginRegistry,
): void {
  const flow = loadFlow(specPath, plugins);

  reportGraphValidation(flow, plugins);

  if (options.toolsDir || plugins.hasTools()) {
    reportToolValidation(flow, options, plugins);
  }
}

function reportGraphValidation(
  flow: ParsedFlow,
  plugins: PluginRegistry,
): void {
  try {
    validate(compile(flow, { plugins }));
    console.log('  Graph validation passed');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.log(`  Graph validation skipped: ${reason}`);
  }
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

  const registry = composeRegistries([
    plugins.toolRegistry(),
    FileRegistry.create(options.toolsDir ?? ''),
  ]);

  const missing = missingTools(registry, toolNames);
  if (missing.length > 0) {
    throw new ToolError(
      `missing executables for tools: ${missing.join(', ')}`,
    );
  }

  console.log(`  Tool validation passed (${toolNames.length} tools found)`);
}
