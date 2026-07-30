import type { ServerResponse } from 'node:http';
import type { WireFrame } from '@heddle/core';

export { serializeEvent } from '@heddle/core';

const DEFAULT_CONTENT_TYPE = 'text/event-stream; charset=utf-8';
const NEWLINES = /[\r\n]+/g;

export class SseStream {
  private closed = false;

  constructor(
    private readonly res: ServerResponse,
    private readonly headers: Record<string, string> = {},
  ) {}

  open(contentType = DEFAULT_CONTENT_TYPE): void {
    this.res.writeHead(200, {
      ...this.headers,
      'content-type': contentType,
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    this.res.flushHeaders?.();
  }

  sendFrame(frame: WireFrame): void {
    if (frame.event === undefined) {
      this.write(`data: ${JSON.stringify(frame.data)}\n\n`);
      return;
    }
    this.send(frame.event, frame.data);
  }

  send(event: string, data: unknown): void {
    const name = event.replace(NEWLINES, ' ');
    this.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.res.end();
  }

  private write(frame: string): void {
    if (this.closed || this.res.writableEnded || this.res.destroyed) return;
    this.res.write(frame);
  }
}
