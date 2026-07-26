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
  private accepted = 0;
  private rejected = 0;

  constructor(private readonly max: number) {}

  get inFlight(): number {
    return this.active;
  }

  /** The configured ceiling — the denominator for saturation. */
  get limit(): number {
    return this.max;
  }

  /** Runs admitted since start. Monotonic; surfaced as a Prometheus counter. */
  get acceptedTotal(): number {
    return this.accepted;
  }

  /** Runs refused for want of a slot since start. Monotonic. */
  get rejectedTotal(): number {
    return this.rejected;
  }

  /** Take a slot, or throw 429. The returned function returns the slot. */
  acquire(): () => void {
    if (this.active >= this.max) {
      this.rejected++;
      throw new HttpError(
        429,
        `server is at its limit of ${this.max} concurrent runs; retry shortly`,
        'TooManyRequests',
      );
    }
    this.active++;
    this.accepted++;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
    };
  }
}
