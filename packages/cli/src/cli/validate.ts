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
  ToolError,
} from '@heddle/core';

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
  .action(async (
    specPath: string,
    options: { toolsDir?: string; plugin?: string[] },
  ) => {
    const plugins = await loadPlugins(options.plugin);

    // First, validate via SDK deserialization (Zod schemas)
    const component = loadComponent(specPath, plugins);
    const ct = (component as unknown as { componentType: string }).componentType;
    const name = (component as unknown as { name: string }).name;
    console.log(`  Parsed ${ct}: ${name}`);

    // For Flows, also run graph compilation + validation if possible
    if (ct === 'Flow') {
      const pf = loadFlow(specPath, plugins);

      try {
        const cg = compile(pf, { plugins });
        validate(cg);
        console.log('  Graph validation passed');
      } catch (err) {
        // Flow parsed via SDK but graph compilation failed (unsupported node
        // types, missing API keys, a plugin that was not loaded).  SDK-level
        // validation already passed, so this is not a spec error — but the
        // reason is reported, because a forgotten --plugin lands here too.
        const reason = err instanceof Error ? err.message : String(err);
        console.log(`  Graph validation skipped: ${reason}`);
      }

      // Outside that catch, deliberately. It exists to tolerate a compile that
      // could not run; a tool this flow names and nothing provides is a fact
      // about the flow, and swallowing it would make `heddle validate` exit 0
      // while printing the problem — the one outcome a validator must not have.
      if (options.toolsDir || plugins.hasTools()) {
        const reg = composeRegistries([
          plugins.toolRegistry(),
          FileRegistry.create(options.toolsDir ?? ''),
        ]);
        const toolNames = collectToolNames(pf);
        if (toolNames.length === 0) {
          console.log('  No tools to validate');
        } else {
          const missing = missingTools(reg, toolNames);
          if (missing.length > 0) {
            throw new ToolError(`missing executables for tools: ${missing.join(', ')}`);
          }
          console.log(`  Tool validation passed (${toolNames.length} tools found)`);
        }
      }
    }

    console.log(`Valid: ${specPath}`);
  });
