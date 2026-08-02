/**
 * The handful of checks half this package was writing for itself.
 *
 * Internal on purpose: nothing here is part of heddle's surface, and exporting
 * a `isObject` would be promising to keep somebody else's type guard stable.
 */

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSet(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/** What a value is, as an error's noun phrase: "null", "an array", "a string". */
export function typeName(value: unknown): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'an array' : `a ${typeof value}`;
}

/** What a value is, as a JSON Schema type word: "null", "array", "integer". */
export function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

export function noop(): void {
  return;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };

    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
