import type { ServerResponse } from 'node:http';
import type { Event } from '@heddle/core';

/**
 * Wire form of a runner {@link Event}.
 *
 * This is the same event model the engine already emits — one SSE frame per
 * runner event, with the event's `type` as the SSE event name. Only `state` and
 * `error` need touching, because neither survives `JSON.stringify` usefully on
 * its own; everything else is carried across as it is.
 *
 * Carried across rather than listed field by field, and that is the point. A
 * fixed list drops anything added to `Event` later without a type error or a
 * warning — `message` was in exactly that state, so every `warning` reached the
 * browser empty. Spreading means a new field arrives on its own.
 */
export function serializeEvent(e: Event): Record<string, unknown> {
  const { state, error, ...rest } = e;
  return {
    ...rest,
    state: state?.toData(),
    error: error && { name: error.name, message: error.message },
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
