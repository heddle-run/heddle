import type { Event, EventHandler } from '../runner/events.js';
import type { PluginEncoder, WireFrame } from './types.js';

export const BUILTIN_PROTOCOL = 'heddle';

export const PROTOCOL_NAME = /^[a-z0-9][a-z0-9-]*$/;

export function serializeEvent(event: Event): Record<string, unknown> {
  const { state, error, ...rest } = event;
  return {
    ...rest,
    state: state?.toData(),
    error: error && { name: error.name, message: error.message },
  };
}

export function builtinEncoder(): PluginEncoder {
  return {
    encode: (event) => [{ event: event.type, data: serializeEvent(event) }],
    finish: () => [],
  };
}

export class EncoderStream {
  private readonly queue: Event[] = [];
  private readonly loop: Promise<void>;
  private wake: (() => void) | undefined;
  private closing = false;
  private failure: Error | undefined;

  constructor(
    private readonly encoder: PluginEncoder,
    private readonly write: (frame: WireFrame) => void,
    private onFailure?: (err: Error) => void,
  ) {
    this.loop = this.drain();
  }

  handler(): EventHandler {
    return (event) => this.offer(event);
  }

  offer(event: Event): void {
    if (this.failure || this.closing) return;

    this.queue.push(event);
    this.nudge();
  }

  async close(): Promise<void> {
    if (!this.closing) {
      this.closing = true;
      this.nudge();
    }

    await this.loop;
    if (this.failure) throw this.failure;
  }

  private async drain(): Promise<void> {
    while (await this.hasMoreWork()) {
      const event = this.queue.shift() as Event;
      const encoded = await this.render(() => this.encoder.encode(event));
      if (!encoded) return;
    }

    await this.render(() => this.encoder.finish());
  }

  private async hasMoreWork(): Promise<boolean> {
    while (this.queue.length === 0) {
      if (this.closing) return false;
      await this.sleepUntilNudged();
    }
    return true;
  }

  private sleepUntilNudged(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wake = resolve;
    });
  }

  private async render(
    produce: () => Promise<WireFrame[]> | WireFrame[],
  ): Promise<boolean> {
    try {
      for (const frame of await produce()) this.write(frame);
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    }
  }

  private nudge(): void {
    this.wake?.();
    this.wake = undefined;
  }

  private fail(err: unknown): void {
    this.failure = err instanceof Error ? err : new Error(String(err));
    this.queue.length = 0;

    const notify = this.onFailure;
    this.onFailure = undefined;
    notify?.(this.failure);
  }
}
