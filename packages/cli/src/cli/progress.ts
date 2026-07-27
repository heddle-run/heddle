import { isPluginEvent, type Event } from '@heddle/core';
import { getToolIcon, getToolTitle, formatDuration } from '../chat/tool-display.js';

/**
 * What the run command has to say about one event.
 *
 * Two kinds, because a model's answer does not arrive in lines. A `fragment` is
 * part of a line still being written; `lines` are whole ones. Keeping them
 * apart is what lets the writer below hold the framing rule in one place.
 */
export type Output =
  | { kind: 'lines'; lines: string[] }
  | { kind: 'fragment'; node: string; text: string };

const lines = (...text: string[]): Output => ({ kind: 'lines', lines: text });

/**
 * The wording for one event, as a pure function of it.
 *
 * Pure so that adding a case cannot break the framing of a streamed answer: a
 * case returns what it wants said and has no way to write it, so there is no
 * way to write it at the wrong moment. This is deliberate — every branch here
 * used to call `console.error` directly, and once an answer can be half-written
 * on the same line, one forgotten call appends to the middle of a sentence.
 */
export function renderEvent(e: Event, verbose: boolean): Output {
  switch (e.type) {
    case 'token_delta':
      // Deliberately not gated on --verbose. Without this the default
      // `heddle run` prints nothing at all while a model is answering, which
      // is the silence streaming exists to fill; requiring a flag would leave
      // the default exactly as it was.
      return { kind: 'fragment', node: e.nodeName ?? '', text: e.delta ?? '' };
    case 'tool_call':
      return lines(
        `[${e.nodeName}] ${getToolIcon(e.toolName!)} ${getToolTitle(e.toolName!, e.toolArgs ?? {})}`,
        ...(verbose ? [`[${e.nodeName}]   args: ${JSON.stringify(e.toolArgs ?? {})}`] : []),
      );
    case 'tool_result':
      if (e.error) {
        return lines(
          `[${e.nodeName}] Error: ${e.toolName} (${formatDuration(e.duration ?? 0)}): ${e.error.message}`,
        );
      }
      return verbose
        ? lines(
            `[${e.nodeName}] Done: ${e.toolName} (${formatDuration(e.duration ?? 0)})`,
            `[${e.nodeName}]   result: ${JSON.stringify(e.toolResult)}`,
          )
        : lines();
    case 'node_start':
      return verbose ? lines(`[${e.nodeName}] Starting ${e.nodeType}`) : lines();
    case 'node_complete':
      return verbose ? lines(`[${e.nodeName}] Completed`) : lines();
    case 'warning':
      return lines(`Warning: ${e.message}`);
    case 'node_error':
      return lines(`[${e.nodeName}] Error: ${e.error}`);
    case 'flow_start':
      return verbose ? lines('Flow started') : lines();
    case 'flow_complete':
      return verbose ? lines('Flow completed') : lines();
    case 'plugin_log':
      // `debug` is the only level a plugin author aims at themselves; the rest
      // are addressed to whoever is running the flow, so they are ungated like
      // `warning` and `node_error` above. Gating them all behind --verbose is
      // what made `ctx.log` look broken from heddle's own primary client, and
      // sent plugin authors back to stderr — capped at 4 KB and shown only when
      // the process fails.
      return e.level === 'debug' && !verbose
        ? lines()
        : lines(`[${e.nodeName}] ${e.level}: ${e.message}`);
    default:
      // A plugin's `data` is opaque to heddle, so this prints the type and the
      // payload rather than enumerating shapes — the same reason `serializeEvent`
      // spreads instead of listing fields. It cannot be a `case`, because a
      // template-literal type has no single label to match. Verbose-gated
      // because a plugin that reports per row would otherwise flood a default
      // run with a shape only a client written against that plugin can read.
      return isPluginEvent(e.type) && verbose
        ? lines(
            `[${e.nodeName}] ${e.type}${
              e.data === undefined ? '' : ` ${JSON.stringify(e.data)}`
            }`,
          )
        : lines();
  }
}

/**
 * Writes {@link Output} to a sink, tracking the answer that is half-written.
 *
 * A fragment is not a line, so the `[node]` prefix goes in once at the start of
 * an answer and the fragments after it are written raw — prefixing each one
 * would shred a single answer across hundreds of labelled lines.
 *
 * Anything that is not a fragment closes that line first. That covers the quiet
 * cases for free: `node_complete` says nothing without --verbose, but it still
 * ends the answer, so the next thing written starts on its own line and the
 * run's JSON result on stdout is never run into.
 */
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
