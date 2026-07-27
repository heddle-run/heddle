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
 * browser empty. Spreading means a new field arrives on its own, which is how
 * `data` and `level` reach a client without this function being told they
 * exist: a plugin's event payload is opaque to heddle, and a rendering that had
 * to enumerate what a plugin can send would be wrong the day after it shipped.
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
    // The event name is the one part of a frame that is not JSON-escaped, so a
    // newline inside it ends the frame early and everything after it is read as
    // a frame of the sender's own composition. `EventType` is no longer closed —
    // a plugin supplies half of `plugin:<componentType>:<name>` — and writing
    // "\n\nevent: flow_complete" into that half is precisely the forgery the
    // namespacing prevents in the type system, reached around it. Names are
    // already refused at construction; this refuses them again at the last
    // point before the wire, because that check lives in another package and
    // this is the line that would carry the damage.
    const name = event.replace(/[\r\n]+/g, ' ');
    this.res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.res.end();
  }
}
