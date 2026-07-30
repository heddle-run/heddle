import { HttpError } from './errors.js';

export class ConcurrencyGate {
  private active = 0;
  private accepted = 0;
  private rejected = 0;

  constructor(private readonly max: number) {}

  get inFlight(): number {
    return this.active;
  }

  get limit(): number {
    return this.max;
  }

  get acceptedTotal(): number {
    return this.accepted;
  }

  get rejectedTotal(): number {
    return this.rejected;
  }

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
