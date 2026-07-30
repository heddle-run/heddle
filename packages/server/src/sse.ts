import type { ServerResponse } from 'node:http';
import type { WireFrame } from '@heddle/core';

/**
 * The wire form of a runner event.
 *
 * Re-exported from core rather than defined here, because an encoder made the
 * rendering something core owns: `?protocol=heddle` is now one encoder among
 * possibly several, and its frames have to be the same whether this server
 * writes them or a CLI does. What stays in this file is the transport — how a
 * frame becomes bytes — which is the server's business and nobody else's.
 *
 * Still exported under this name because that is what it is called everywhere
 * that uses it, and because the guarantee its tests pin — that no field of an
 * `Event` is dropped on the way out — is a guarantee about this name.
 */
export { serializeEvent } from '@heddle/core';

/** Writes Server-Sent Events frames to a response. */
export class SseStream {
  private closed = false;

  constructor(
    private readonly res: ServerResponse,
    private readonly headers: Record<string, string> = {},
  ) {}

  /**
   * Open the stream.
   *
   * `contentType` is the encoder's, because a protocol other than heddle's own
   * may not be SSE at all. It defaults to `text/event-stream` so the ordinary
   * case says nothing, and an encoder declaring something else gets it.
   */
  open(contentType = 'text/event-stream; charset=utf-8'): void {
    this.res.writeHead(200, {
      ...this.headers,
      'content-type': contentType,
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Tell nginx and friends not to buffer the stream.
      'x-accel-buffering': 'no',
    });
    // Flush headers immediately so the client sees the stream open before the
    // first event, which for a long flow may be a while.
    this.res.flushHeaders?.();
  }

  /**
   * Write one frame an encoder produced.
   *
   * A frame with no `event` writes a bare `data:` line, and that is not a
   * degenerate case — it is what a protocol carrying its own type inside the
   * payload requires. AG-UI is one: its frames are `data: {"type":"RUN_STARTED",…}`
   * with no event name, and a client reads one stream and switches on the
   * payload. heddle's own frames are the other shape, where the event type *is*
   * the name so a browser can subscribe to it.
   */
  sendFrame(frame: WireFrame): void {
    if (frame.event === undefined) {
      this.write(`data: ${JSON.stringify(frame.data)}\n\n`);
      return;
    }
    this.send(frame.event, frame.data);
  }

  send(event: string, data: unknown): void {
    // The event name is the one part of a frame that is not JSON-escaped, so a
    // newline inside it ends the frame early and everything after it is read as
    // a frame of the sender's own composition. `EventType` is no longer closed —
    // a plugin supplies half of `plugin:<componentType>:<name>` — and writing
    // "\n\nevent: flow_complete" into that half is precisely the forgery the
    // namespacing prevents in the type system, reached around it. Names are
    // already refused at construction, and an encoder's frame name is refused
    // again by `readWireFrames`; this refuses them a third time at the last
    // point before the wire, because those checks live in another package and
    // this is the line that would carry the damage.
    const name = event.replace(/[\r\n]+/g, ' ');
    this.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private write(frame: string): void {
    // `closed` is this stream's own state; the other two are the socket's. A
    // caller that hangs up destroys the response without anything here being
    // told, and an encoder is still asked to `finish` on that path — deliberately,
    // so a protocol's terminal frame is produced even for an aborted run. Those
    // frames then have nowhere to go, and writing to a destroyed response is how
    // a dropped connection turns into an `error` event on a response nothing is
    // listening to. Dropped silently instead: there is no reader left to tell.
    if (this.closed || this.res.writableEnded || this.res.destroyed) return;
    this.res.write(frame);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.res.end();
  }
}
