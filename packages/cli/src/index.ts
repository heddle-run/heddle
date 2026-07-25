/**
 * Library entry point for the CLI package.
 *
 * Importing this module has no side effects — it does not read argv, write to
 * stdout, or exit the process. The executable entry point is `specrun.ts`,
 * which is what the `bin` field points at.
 */
export { program } from './cli/root.js';
export { runCommand } from './cli/run.js';
export { validateCommand } from './cli/validate.js';
export { initCommand } from './cli/init.js';
