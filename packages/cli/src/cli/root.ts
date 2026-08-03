import { createRequire } from 'node:module';
import { Command } from 'commander';
import { runCommand } from './run.js';
import { bundleCommand } from './bundle.js';
import { validateCommand } from './validate.js';
import { doctorCommand } from './doctor.js';
import { initCommand } from './init.js';
import { sessionsCommand } from './sessions.js';

// A self-reference, which Node resolves through this package's own "exports"
// map — so the same specifier finds package.json from src under the test
// runner and from the bundled dist a user installs.
const { version } = createRequire(import.meta.url)(
  '@heddle-run/cli/package.json',
) as { version: string };

export const program = new Command('heddle')
  .description('Lightweight CLI agentic workflow framework')
  .version(version)
  .option('--verbose', 'Enable verbose output', false)
  .option('--trace', 'Enable trace-level output', false);

program.addCommand(runCommand);
program.addCommand(bundleCommand);
program.addCommand(validateCommand);
program.addCommand(doctorCommand);
program.addCommand(initCommand);
program.addCommand(sessionsCommand);
