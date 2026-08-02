import { PluginError } from '../errors.js';
import type { Event, EventHandler } from '../runner/events.js';
import type { PluginEncoder, PluginEncoderDef, WireFrame } from './types.js';

export const BUILTIN_PROTOCOL = 'heddle';

export const PROTOCOL_NAME = /^[a-z0-9][a-z0-9-]*$/;

const BUILTIN_CONTENT_TYPE = 'text/event-stream; charset=utf-8';

/** Where an encoder may come from — structurally, what a `PluginRegistry` is. */
interface EncoderSource {
  encoderDef(protocol: string): PluginEncoderDef | undefined;
  encoderProtocols(): string[];
}

export interface ResolvedEncoder {
  protocol: string;
  contentType: string;
  create(runId: string): PluginEncoder;
}

/**
 * The encoder behind a protocol name: heddle's own, or a plugin's.
 *
 * The one resolution rule both surfaces share. What differs per caller is only
 * the advice — where a missing plugin would have come from — so each wraps the
 * error in its own transport class and appends its own sentence.
 */
export function encoderFor(
  protocol: string,
  plugins: EncoderSource,
): ResolvedEncoder {
  if (protocol === BUILTIN_PROTOCOL) {
    return {
      protocol: BUILTIN_PROTOCOL,
      contentType: BUILTIN_CONTENT_TYPE,
      create: () => builtinEncoder(),
    };
  }

  const def = plugins.encoderDef(protocol);
  if (def) {
    return {
      protocol,
      contentType: def.contentType,
      create: (runId) => def.createEncoder(runId),
    };
  }

  const available = [BUILTIN_PROTOCOL, ...plugins.encoderProtocols()];
  throw new PluginError(
    `no encoder for protocol "${protocol}". Available: ${available.join(', ')}.`,
  );
}

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
  // Drained by index rather than by `shift()`, which moves every remaining
  // element on each frame. The array is emptied wholesale once it is caught up.
  private queue: Event[] = [];
  private head = 0;
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
      const event = this.queue[this.head++];
      const encoded = await this.render(() => this.encoder.encode(event));
      if (!encoded) return;
    }

    await this.render(() => this.encoder.finish());
  }

  private async hasMoreWork(): Promise<boolean> {
    while (this.head >= this.queue.length) {
      this.queue = [];
      this.head = 0;
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
    this.queue = [];
    this.head = 0;

    const notify = this.onFailure;
    this.onFailure = undefined;
    notify?.(this.failure);
  }
}
