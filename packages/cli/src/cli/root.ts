import { Command } from 'commander';
import { runCommand } from './run.js';
import { validateCommand } from './validate.js';
import { initCommand } from './init.js';

export const program = new Command('specrun')
  .description('Lightweight CLI agentic workflow framework')
  .option('--verbose', 'Enable verbose output', false)
  .option('--trace', 'Enable trace-level output', false);

program.addCommand(runCommand);
program.addCommand(validateCommand);
program.addCommand(initCommand);
