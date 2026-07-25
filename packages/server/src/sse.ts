import type { ServerResponse } from 'node:http';
import type { Event } from '@heddle/core';

/**
 * Wire form of a runner {@link Event}.
 *
 * This is the same event model the engine already emits — one SSE frame per
 * runner event, with the event's `type` as the SSE event name. The only
 * transformations are the ones JSON forces: `State` becomes a plain object and
 * `Error` becomes `{name, message}`, since neither survives `JSON.stringify`
 * usefully on its own.
 */
export function serializeEvent(e: Event): Record<string, unknown> {
  return {
    type: e.type,
    nodeName: e.nodeName,
    nodeType: e.nodeType,
    state: e.state?.toData(),
    error: e.error ? { name: e.error.name, message: e.error.message } : undefined,
    toolName: e.toolName,
    toolArgs: e.toolArgs,
    toolResult: e.toolResult,
    toolCallId: e.toolCallId,
    startedAt: e.startedAt,
    duration: e.duration,
  };
}

/** Writes Server-Sent Events frames to a response. */
export class SseStream {
  private closed = false;

  constructor(private readonly res: ServerResponse) {}

  open(): void {
    this.res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Tell nginx and friends not to buffer the stream.
      'x-accel-buffering': 'no',
    });
    // Flush headers immediately so the client sees the stream open before the
    // first event, which for a long flow may be a while.
    this.res.flushHeaders?.();
  }

  send(event: string, data: unknown): void {
    if (this.closed) return;
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.res.end();
  }
}
