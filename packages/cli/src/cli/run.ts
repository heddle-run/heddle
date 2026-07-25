import { Command } from 'commander';
import {
  compile,
  validate,
  loadFlow,
  collectToolNames,
  propertyTitle,
  FileRegistry,
  SubprocessExecutor,
  Runner,
  DEFAULT_RUNNER_OPTIONS,
  type RunnerOptions,
  type Event,
  type ParsedFlow,
} from '@heddle/core';
import { getToolIcon, getToolTitle, formatDuration } from '../chat/tool-display.js';

function buildRunnerOpts(verbose: boolean, chat: boolean): RunnerOptions {
  const opts = { ...DEFAULT_RUNNER_OPTIONS, verbose };
  if (!chat) {
    opts.eventHandler = (e: Event) => {
      switch (e.type) {
        case 'tool_call':
          console.error(`[${e.nodeName}] ${getToolIcon(e.toolName!)} ${getToolTitle(e.toolName!, e.toolArgs ?? {})}`);
          if (verbose) {
            console.error(`[${e.nodeName}]   args: ${JSON.stringify(e.toolArgs ?? {})}`);
          }
          break;
        case 'tool_result':
          if (e.error) {
            console.error(`[${e.nodeName}] Error: ${e.toolName} (${formatDuration(e.duration ?? 0)}): ${e.error.message}`);
          } else if (verbose) {
            console.error(`[${e.nodeName}] Done: ${e.toolName} (${formatDuration(e.duration ?? 0)})`);
            console.error(`[${e.nodeName}]   result: ${JSON.stringify(e.toolResult)}`);
          }
          break;
        case 'node_start':
          if (verbose) console.error(`[${e.nodeName}] Starting ${e.nodeType}`);
          break;
        case 'node_complete':
          if (verbose) console.error(`[${e.nodeName}] Completed`);
          break;
        case 'node_error':
          console.error(`[${e.nodeName}] Error: ${e.error}`);
          break;
        case 'flow_start':
          if (verbose) console.error('Flow started');
          break;
        case 'flow_complete':
          if (verbose) console.error('Flow completed');
          break;
      }
    };
  }
  return opts;
}

/** Determine the primary input key from the flow's StartNode outputs. */
function detectInputKey(pf: ParsedFlow): string {
  for (const n of pf.parsedNodes) {
    if (n.componentType === 'StartNode' && n.outputs && n.outputs.length > 0) {
      const title = propertyTitle(n.outputs[0]);
      if (title) return title;
    }
  }
  return 'query';
}

export const runCommand = new Command('run')
  .description('Run an Agent Spec flow')
  .argument('<flow>', 'Path to flow JSON or YAML file')
  .option('--tools-dir <dir>', 'Directory containing tool executables')
  .option('--input <json>', 'Input JSON object')
  .option('--chat', 'Open an interactive chat session')
  .action(
    async (
      flowPath: string,
      options: { toolsDir?: string; input?: string; chat?: boolean },
      command: Command,
    ) => {
      const verbose = command.parent?.opts().verbose ?? false;

      const pf = loadFlow(flowPath);

      const reg = FileRegistry.create(options.toolsDir ?? '');
      const toolNames = collectToolNames(pf);
      if (toolNames.length > 0) {
        reg.validateTools(toolNames);
      }

      const isChat = options.chat ?? false;
      const opts = buildRunnerOpts(verbose, isChat);

      const deps = {
        toolExecutor: new SubprocessExecutor(),
        toolRegistry: reg,
        eventHandler: (e: Event) => opts.eventHandler?.(e),
      };

      const cg = compile(pf, deps);
      validate(cg);

      if (isChat) {
        const { createSession } = await import('../chat/session.js');
        const { startChat } = await import('../chat/ui.js');
        const session = createSession(flowPath);
        const inputKey = detectInputKey(pf);

        console.error(`Conversation saved to: ~/.heddle/conversations/${session.id}.json`);
        startChat({ graph: cg, opts, session, inputKey });
        return;
      }

      let inputs: Record<string, unknown>;
      if (options.input) {
        try {
          inputs = JSON.parse(options.input);
        } catch (err) {
          throw new Error('failed to parse --input JSON', { cause: err });
        }
      } else {
        inputs = {};
      }

      const runner = new Runner(cg, opts);
      const result = await runner.run(undefined, inputs);
      console.log(JSON.stringify(result.toData(), null, 2));
    },
  );
