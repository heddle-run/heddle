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
 *
 * The field list is fixed, and that is a hazard worth naming: a field added to
 * `Event` and not added here is dropped silently — no type error, no warning,
 * just a client that never sees it. `message` was in exactly that state, so
 * every `warning` reached the browser with nothing in it. Anything added to
 * `Event` has to be added here in the same change.
 */
export function serializeEvent(e: Event): Record<string, unknown> {
  return {
    type: e.type,
    message: e.message,
    delta: e.delta,
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

  constructor(
    private readonly res: ServerResponse,
    private readonly headers: Record<string, string> = {},
  ) {}

  open(): void {
    this.res.writeHead(200, {
      ...this.headers,
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
