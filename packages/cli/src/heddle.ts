#!/usr/bin/env node
import { program } from './cli/root.js';

program.parseAsync(process.argv).catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
