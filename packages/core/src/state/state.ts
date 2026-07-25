/**
 * State holds key-value data flowing through the graph.
 * It uses an immutable pattern: mutating methods return a new State.
 */
export class State {
  private readonly data: Record<string, unknown>;

  constructor(data?: Record<string, unknown> | null) {
    this.data = data ? { ...data } : {};
  }

  /** Wrap already-owned data without copying. */
  private static fromOwned(data: Record<string, unknown>): State {
    const s = Object.create(State.prototype) as State;
    (s as unknown as { data: Record<string, unknown> }).data = data;
    return s;
  }

  has(key: string): boolean {
    return key in this.data;
  }

  get(key: string): unknown {
    return this.data[key];
  }

  getString(key: string): string | undefined {
    const v = this.data[key];
    return typeof v === 'string' ? v : undefined;
  }

  set(key: string, value: unknown): State {
    return State.fromOwned({ ...this.data, [key]: value });
  }

  merge(other: State): State {
    return State.fromOwned({ ...this.data, ...other.data });
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
