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
