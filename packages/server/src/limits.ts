import { HttpError } from './errors.js';

/**
 * A cap on runs executing at once.
 *
 * Runs are not cheap and not bounded by the request body: a flow can spawn tool
 * subprocesses and sit waiting on model calls for the whole timeout. Without a
 * ceiling, a handful of concurrent requests is enough to exhaust the host, so
 * excess requests are refused immediately rather than queued — a caller learns
 * now that the server is busy instead of holding a connection open to find out.
 */
export class ConcurrencyGate {
  private active = 0;

  constructor(private readonly max: number) {}

  get inFlight(): number {
    return this.active;
  }

  /** Take a slot, or throw 429. The returned function returns the slot. */
  acquire(): () => void {
    if (this.active >= this.max) {
      throw new HttpError(
        429,
        `server is at its limit of ${this.max} concurrent runs; retry shortly`,
        'TooManyRequests',
      );
    }
    this.active++;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
    };
  }
}
