import { Command } from 'commander';
import { generate } from '../scaffold/templates.js';

export const initCommand = new Command('init')
  .description('Scaffold a new specrun project')
  .argument('<project-name>', 'Name of the project directory')
  .action((dir: string) => {
    generate(dir);

    console.log(`Created project in ${dir}/`);
    console.log('  flow.json              - Agent Spec flow definition');
    console.log('  tools/example_tool.sh  - Example tool script');
    console.log();
    console.log('Next steps:');
    console.log(`  1. Edit ${dir}/flow.json to define your workflow`);
    console.log(`  2. Add tool scripts to ${dir}/tools/`);
    console.log(
      `  3. Run: specrun run ${dir}/flow.json --tools-dir ${dir}/tools --input '{"query": "hello"}'`,
    );
  });
