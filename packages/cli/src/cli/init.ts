import { Command } from 'commander';
import { generate } from '../scaffold/templates.js';

export const initCommand = new Command('init')
  .description('Scaffold a new heddle project')
  .argument('<project-name>', 'Name of the project directory')
  .action((dir: string) => {
    generate(dir);

    console.log(`Created project in ${dir}/`);
    console.log('  weave.yaml             - the agent, in the Weave format');
    console.log('  tools/example_tool.sh  - Example tool script');
    console.log();
    console.log('Next steps:');
    console.log(`  1. Edit ${dir}/weave.yaml to define your agent`);
    console.log(`  2. Add tool scripts to ${dir}/tools/`);
    console.log(
      '  3. Set the model credential: export OPENAI_API_KEY=sk-...',
    );
    console.log(
      `  4. Run: heddle run ${dir}/weave.yaml --tools-dir ${dir}/tools --input '{"query": "hello"}'`,
    );
  });
