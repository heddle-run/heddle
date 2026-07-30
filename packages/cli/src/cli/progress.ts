import { isPluginEvent, type Event } from '@heddle/core';
import {
  getToolIcon,
  getToolTitle,
  formatDuration,
} from '../chat/tool-display.js';

export type Output =
  | { kind: 'lines'; lines: string[] }
  | { kind: 'fragment'; node: string; text: string };

export function renderEvent(event: Event, verbose: boolean): Output {
  switch (event.type) {
    case 'token_delta':
      return {
        kind: 'fragment',
        node: event.nodeName ?? '',
        text: event.delta ?? '',
      };
    case 'tool_call':
      return renderToolCall(event, verbose);
    case 'tool_result':
      return renderToolResult(event, verbose);
    case 'node_start':
      return whenVerbose(verbose, `[${event.nodeName}] Starting ${event.nodeType}`);
    case 'node_complete':
      return whenVerbose(verbose, `[${event.nodeName}] Completed`);
    case 'warning':
      return lines(`Warning: ${event.message}`);
    case 'node_error':
      return lines(`[${event.nodeName}] Error: ${event.error}`);
    case 'flow_start':
      return whenVerbose(verbose, 'Flow started');
    case 'flow_complete':
      return whenVerbose(verbose, 'Flow completed');
    case 'plugin_log':
      return renderPluginLog(event, verbose);
    default:
      return renderPluginEvent(event, verbose);
  }
}

export function createProgressWriter(
  write: (text: string) => void,
): (out: Output) => void {
  let openNode: string | null = null;

  return (out) => {
    if (out.kind === 'fragment') {
      if (openNode !== out.node) {
        if (openNode !== null) write('\n');
        write(`[${out.node}] `);
        openNode = out.node;
      }
      write(out.text);
      return;
    }

    if (openNode !== null) {
      write('\n');
      openNode = null;
    }
    for (const line of out.lines) write(`${line}\n`);
  };
}

function renderToolCall(event: Event, verbose: boolean): Output {
  const toolName = event.toolName as string;
  const args = event.toolArgs ?? {};

  return lines(
    `[${event.nodeName}] ${getToolIcon(toolName)} ${getToolTitle(toolName, args)}`,
    ...(verbose
      ? [`[${event.nodeName}]   args: ${JSON.stringify(args)}`]
      : []),
  );
}

function renderToolResult(event: Event, verbose: boolean): Output {
  const duration = formatDuration(event.duration ?? 0);

  if (event.error) {
    return lines(
      `[${event.nodeName}] Error: ${event.toolName} (${duration}): ${event.error.message}`,
    );
  }
  if (!verbose) return lines();

  return lines(
    `[${event.nodeName}] Done: ${event.toolName} (${duration})`,
    `[${event.nodeName}]   result: ${JSON.stringify(event.toolResult)}`,
  );
}

function renderPluginLog(event: Event, verbose: boolean): Output {
  if (event.level === 'debug' && !verbose) return lines();
  return lines(`[${event.nodeName}] ${event.level}: ${event.message}`);
}

function renderPluginEvent(event: Event, verbose: boolean): Output {
  if (!isPluginEvent(event.type) || !verbose) return lines();

  const payload = event.data === undefined ? '' : ` ${JSON.stringify(event.data)}`;
  return lines(`[${event.nodeName}] ${event.type}${payload}`);
}

function whenVerbose(verbose: boolean, text: string): Output {
  return verbose ? lines(text) : lines();
}

function lines(...text: string[]): Output {
  return { kind: 'lines', lines: text };
}
