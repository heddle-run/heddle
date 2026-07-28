/**
 * The two questions every parser in heddle asks of a value it did not produce.
 *
 * A protocol frame from a plugin's stdout, a manifest from a request body, a
 * spec document, a plugin's return value: each is `JSON.parse` output, and each
 * used to open with its own spelling of "is this an object" and its own way of
 * naming what arrived instead. Five spellings of the same predicate is five
 * chances for one of them to forget `Array.isArray` — which is the one that
 * matters, since `typeof [] === 'object'`.
 */

/**
 * A JSON object: not `null`, not an array.
 *
 * Both exclusions are load-bearing. `JSON.parse('null')` is `null`, and reading
 * a property off it throws — on a stdout handler's stack, in the case that
 * matters, where nothing catches it. An array passes `typeof value === 'object'`
 * and would then be walked as if it had named fields.
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What a value is, in the words an error message wants.
 *
 * `typeof` alone answers "object" for `null` and for an array, which is the
 * least useful thing to tell someone whose plugin returned the wrong shape.
 */
export function typeName(value: unknown): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}
