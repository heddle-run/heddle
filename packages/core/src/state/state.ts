/**
 * The bag of named values a run carries: what the inputs start it with, what
 * each node adds, and what an `EndNode` hands back.
 *
 * Immutable — `set` and `merge` return a new `State`, and the constructor
 * copies what it is given — which is what lets the runner keep a state per
 * node output and hand states to middleware without any of them writing over
 * the others. Values are whatever JSON holds; `merge` is a shallow spread, so
 * on a key both sides have, the other state's value wins.
 */
export class State {
  private readonly data: Record<string, unknown>;

  constructor(data?: Record<string, unknown> | null) {
    this.data = data ? { ...data } : {};
  }

  has(key: string): boolean {
    return key in this.data;
  }

  get(key: string): unknown {
    return this.data[key];
  }

  getString(key: string): string | undefined {
    const value = this.data[key];
    return typeof value === 'string' ? value : undefined;
  }

  set(key: string, value: unknown): State {
    return new State({ ...this.data, [key]: value });
  }

  merge(other: State): State {
    return new State({ ...this.data, ...other.data });
  }

  clone(): State {
    return new State(this.data);
  }

  keys(): string[] {
    return Object.keys(this.data);
  }

  toData(): Record<string, unknown> {
    return this.toJSON();
  }

  toJSON(): Record<string, unknown> {
    return { ...this.data };
  }

  toString(): string {
    try {
      return JSON.stringify(this.data);
    } catch (err) {
      return `<error: ${err}>`;
    }
  }
}
