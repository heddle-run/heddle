/**
 * A deliberately small JSON Schema subset, used to validate spec components
 * against a plugin's manifest.
 *
 * The in-process API validates with a callback, so a plugin author brings
 * whatever validator they like. A manifest cannot do that — it is data — so
 * heddle has to do the checking, and that means owning a validator.
 *
 * This one is a subset rather than a dependency. `@heddle/core` is on the path
 * of a remote-code-execution surface, and a schema validator is a parser over
 * hostile input; the smaller the better. Supported:
 *
 *   type, required, properties, additionalProperties (boolean only),
 *   enum, const, items, minimum, maximum, minLength, maxLength, pattern
 *
 * Anything else in a schema is ignored rather than rejected, so a schema
 * written against full JSON Schema still validates — just less strictly than
 * its author intended. That is the trade, and it is stated here because a
 * validator that silently under-checks is worth knowing about.
 */
import { PluginError } from '../errors.js';
import { isObject } from '../json.js';

type Schema = Record<string, unknown>;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  // JSON Schema's `number` admits integers; `integer` does not admit floats.
  if (expected === 'number') return typeof value === 'number';
  return typeOf(value) === expected;
}

/**
 * Check `value` against `schema`, throwing a PluginError naming the path that
 * failed. `where` prefixes the path so a message names the component.
 */
export function checkSchema(value: unknown, schema: Schema, where: string): void {
  walk(value, schema, where);
}

function walk(value: unknown, schema: Schema, path: string): void {
  const fail = (message: string): never => {
    throw new PluginError(`${path}: ${message}`);
  };

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeof t === 'string' && matchesType(value, t))) {
      fail(`expected ${types.join(' or ')}, got ${typeOf(value)}`);
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((option) => deepEqual(option, value))) {
    fail(`must be one of ${schema.enum.map((o) => JSON.stringify(o)).join(', ')}`);
  }

  if ('const' in schema && !deepEqual(schema.const, value)) {
    fail(`must be ${JSON.stringify(schema.const)}`);
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      fail(`must be at least ${schema.minLength} characters`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      fail(`must be at most ${schema.maxLength} characters`);
    }
    if (typeof schema.pattern === 'string') {
      let re: RegExp;
      try {
        re = new RegExp(schema.pattern);
      } catch {
        fail(`schema has an invalid "pattern": ${schema.pattern}`);
      }
      if (!re!.test(value)) fail(`must match /${schema.pattern}/`);
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      fail(`must be >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      fail(`must be <= ${schema.maximum}`);
    }
  }

  if (Array.isArray(value) && schema.items && typeof schema.items === 'object') {
    value.forEach((entry, i) => walk(entry, schema.items as Schema, `${path}[${i}]`));
  }

  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};

    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && !(key in value)) {
          fail(`"${key}" is required`);
        }
      }
    }

    for (const [key, sub] of Object.entries(properties)) {
      if (key in value && isObject(sub)) {
        walk(value[key], sub, `${path}.${key}`);
      }
    }

    // Only the boolean form. The schema form would mean recursing into
    // arbitrary extra properties, which is more surface than this needs.
    if (schema.additionalProperties === false) {
      const extra = Object.keys(value).filter((key) => !(key in properties));
      if (extra.length > 0) {
        fail(`unexpected propert${extra.length === 1 ? 'y' : 'ies'} ${extra.join(', ')}`);
      }
    }
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, i) => deepEqual(entry, b[i]));
  }
  if (typeof a === 'object') {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    return keys.every((key) => key in right && deepEqual(left[key], right[key]));
  }
  return false;
}
