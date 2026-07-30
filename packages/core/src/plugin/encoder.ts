/**
 * Rendering a run: the builtin encoder, and the drain that carries any encoder.
 *
 * Two things live here, and they are separate on purpose. {@link
 * builtinEncoder} is heddle's own wire form expressed as a {@link
 * PluginEncoder}, so the shape a browser has always received is now one
 * implementation of the same interface a plugin implements rather than a
 * privileged path beside it. {@link EncoderStream} is what lets any encoder be
 * driven from the engine at all, and it exists because of a mismatch the rest of
 * this file cannot paper over: {@link EventHandler} is synchronous and returns
 * nothing, while an out-of-process encoder answers over a pipe.
 */
import type { Event, EventHandler } from '../runner/events.js';
import type { PluginEncoder, WireFrame } from './types.js';

/**
 * The protocol name of heddle's own frames.
 *
 * A real name in the same namespace a plugin's `protocol` competes in, rather
 * than `undefined` meaning "the default". A client that wants today's frames
 * can ask for them by name and get the same answer on a heddle where somebody
 * has installed three encoders — and `?protocol=heddle` reads as a choice,
 * which it now is.
 */
export const BUILTIN_PROTOCOL = 'heddle';

/**
 * What a protocol name may look like.
 *
 * Stricter than a component type, and differently shaped: lower-case with
 * hyphens, because this one is not an identifier a plugin author writes in code
 * but a token a client puts in a query string. `ag-ui` is the name the protocol
 * actually goes by, and a rule that forced `AgUi` or `ag_ui` would have heddle
 * inventing a spelling for somebody else's protocol.
 *
 * The characters are the URL-safe ones on purpose. A protocol name arrives in
 * `?protocol=` and comes back in error messages naming what was asked for, so
 * refusing anything needing escaping keeps both ends free of it.
 */
export const PROTOCOL_NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Wire form of a runner {@link Event}.
 *
 * Only `state` and `error` need touching, because neither survives
 * `JSON.stringify` usefully on its own; everything else is carried across as it
 * is.
 *
 * Carried across rather than listed field by field, and that is the point. A
 * fixed list drops anything added to `Event` later without a type error and
 * without a warning — `message` was in exactly that state, so every `warning`
 * reached the browser empty. Spreading means a new field arrives on its own,
 * which is how `data`, `level` and `attempt` reached clients without this
 * function being told they exist: a plugin's event payload is opaque to heddle,
 * and a rendering that had to enumerate what a plugin can send would be wrong
 * the day after it shipped.
 *
 * It is also why {@link import('../runner/events.js').EVENT_CONTRACT_VERSION}
 * does not move when a field is added. This function is the reason that
 * direction is safe.
 */
export function serializeEvent(e: Event): Record<string, unknown> {
  const { state, error, ...rest } = e;
  return {
    ...rest,
    state: state?.toData(),
    error: error && { name: error.name, message: error.message },
  };
}

/**
 * heddle's own frames: one per runner event, the event's `type` as its name.
 *
 * Stateless, unlike every other encoder worth writing, and it can afford to be
 * because it renders heddle's event model rather than translating it — there is
 * no message to open, no id to invent and nothing to say at the end. `finish`
 * returning nothing is the honest answer rather than an unimplemented one: a
 * client watching these frames learns the run is over from `flow_complete`,
 * which the engine emits itself.
 */
export function builtinEncoder(): PluginEncoder {
  return {
    encode: (event) => [{ event: event.type, data: serializeEvent(event) }],
    finish: () => [],
  };
}

/**
 * Drive an encoder from the engine's synchronous event handler.
 *
 * The mismatch this solves is the mirror image of `pullFrom` in `remote.ts`,
 * and it is worth naming as such. There, a plugin *pushed* frames and a
 * `Provider` had to *pull* them. Here the engine pushes events from
 * {@link EventHandler} — synchronous, returning nothing, with no way to be told
 * "not yet" — and an encoder may answer asynchronously, because out of process
 * it answers over a pipe. So the events are queued and one loop drains them.
 *
 * Three properties, each of which a simpler design loses:
 *
 * 1. **Order is the engine's order.** One loop, never two, and it awaits each
 *    `encode` before starting the next. Calling `encode` per event without a
 *    queue would put a remote encoder's round trips in flight together, and two
 *    frames whose relative order a protocol depends on — `TEXT_MESSAGE_START`
 *    and the delta after it — would race.
 * 2. **Nothing is written after the run is reported done.** {@link close}
 *    resolves only once the backlog is drained and `finish` has run, which is
 *    what lets a caller send its own terminal frame afterwards and know it is
 *    last.
 * 3. **A failed encoder is reported once, and stops.** The first throw is kept
 *    and re-thrown from `close`; nothing further is rendered. An encoder that
 *    throws on every event would otherwise produce one failure per event, all
 *    saying the same thing, on a stream whose rendering is already broken.
 *
 * There is no back-pressure and there cannot be, for `pullFrom`'s reason: the
 * producer is the engine running a flow, and an encoder that falls behind grows
 * the queue rather than slowing the run down. The bound is the run's own
 * wall-clock budget.
 */
export class EncoderStream {
  private readonly queue: Event[] = [];
  private wake: (() => void) | undefined;
  private closing = false;
  private failure: Error | undefined;
  private readonly loop: Promise<void>;

  constructor(
    private readonly encoder: PluginEncoder,
    /**
     * Where a frame goes. Synchronous, because a transport is a socket write —
     * an async sink here would need its own ordering guarantee on top of this
     * one, and nothing has asked for a second queue.
     */
    private readonly write: (frame: WireFrame) => void,
    /**
     * Called once, on the first failure, before {@link close} is reached.
     *
     * {@link close} throwing is how the failure is *reported*; this is how it is
     * acted on, and the two are needed separately because `close` is only
     * awaited once the run is over. An encoder that throws on the second of
     * fifty nodes would otherwise leave the run to finish rendering nothing,
     * and the caller to pay for all of it.
     */
    private onFailure?: (err: Error) => void,
  ) {
    this.loop = this.drain();
  }

  /**
   * The {@link EventHandler} to hand the engine.
   *
   * A bound method rather than the class, so what the runner receives is the
   * one-argument function its own type says it is.
   */
  handler(): EventHandler {
    return (event) => this.offer(event);
  }

  /** Queue one event. Never throws: the engine is not the encoder's caller. */
  offer(event: Event): void {
    // Silent after a failure, which is the whole of property 3. The stream is
    // already broken and its caller has already been told; queueing more work
    // for an encoder that is not answering only delays the report.
    if (this.failure || this.closing) return;
    this.queue.push(event);
    this.nudge();
  }

  /**
   * Finish the rendering: drain what is queued, then flush the encoder's own
   * trailing frames.
   *
   * Idempotent, because the paths that have to call it — a run that returned, a
   * run that threw, a caller that hung up — are not mutually exclusive, and a
   * `finally` that ran twice must not produce two `RUN_FINISHED`s.
   *
   * Throws whatever the encoder threw, if anything did. That is deliberate: the
   * caller is the one holding the transport, so it is the only party that can
   * both report the failure and stop the run.
   */
  async close(): Promise<void> {
    if (this.closing) {
      await this.loop;
      if (this.failure) throw this.failure;
      return;
    }
    this.closing = true;
    this.nudge();
    await this.loop;
    if (this.failure) throw this.failure;
  }

  private nudge(): void {
    this.wake?.();
    this.wake = undefined;
  }

  private async drain(): Promise<void> {
    for (;;) {
      while (this.queue.length > 0) {
        const event = this.queue.shift()!;
        try {
          for (const frame of await this.encoder.encode(event)) this.write(frame);
        } catch (err) {
          this.fail(err);
          return;
        }
      }
      if (this.closing) break;
      // Setting `wake` cannot race the producer: `new Promise`'s executor runs
      // synchronously, and there is no `await` between the queue check above
      // and the assignment.
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }

    try {
      for (const frame of await this.encoder.finish()) this.write(frame);
    } catch (err) {
      this.fail(err);
    }
  }

  private fail(err: unknown): void {
    this.failure = err instanceof Error ? err : new Error(String(err));
    // Whatever had piled up behind the failure is dropped rather than left for
    // a later `close` to try again against an encoder that has already failed.
    this.queue.length = 0;
    // Guarded, because whoever handles this is entitled to assume it happens
    // once: `finish` can fail after `encode` already did, and "the rendering
    // broke" is one event however many frames it broke on.
    const notify = this.onFailure;
    this.onFailure = undefined;
    notify?.(this.failure);
  }
}
