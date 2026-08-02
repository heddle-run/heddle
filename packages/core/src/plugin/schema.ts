import { PluginError } from '../errors.js';
import { isObject as isPlainObject, typeOf } from '../internal/util.js';

type Schema = Record<string, unknown>;

export function checkSchema(
  value: unknown,
  schema: Schema,
  where: string,
): void {
  walk(value, schema, where);
}

function walk(value: unknown, schema: Schema, path: string): void {
  checkType(value, schema, path);
  checkEnum(value, schema, path);
  checkConst(value, schema, path);

  if (typeof value === 'string') checkString(value, schema, path);
  if (typeof value === 'number') checkNumber(value, schema, path);
  if (Array.isArray(value)) checkItems(value, schema, path);
  if (isPlainObject(value)) checkObject(value, schema, path);
}

function checkType(value: unknown, schema: Schema, path: string): void {
  if (schema.type === undefined) return;

  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const matches = types.some(
    (type) => typeof type === 'string' && matchesType(value, type),
  );

  if (!matches) {
    fail(path, `expected ${types.join(' or ')}, got ${typeOf(value)}`);
  }
}

function checkEnum(value: unknown, schema: Schema, path: string): void {
  if (!Array.isArray(schema.enum)) return;
  if (schema.enum.some((option) => deepEqual(option, value))) return;

  const options = schema.enum.map((option) => JSON.stringify(option)).join(', ');
  fail(path, `must be one of ${options}`);
}

function checkConst(value: unknown, schema: Schema, path: string): void {
  if (!('const' in schema)) return;
  if (deepEqual(schema.const, value)) return;

  fail(path, `must be ${JSON.stringify(schema.const)}`);
}

function checkString(value: string, schema: Schema, path: string): void {
  const { minLength, maxLength, pattern } = schema;

  if (typeof minLength === 'number' && value.length < minLength) {
    fail(path, `must be at least ${minLength} characters`);
  }
  if (typeof maxLength === 'number' && value.length > maxLength) {
    fail(path, `must be at most ${maxLength} characters`);
  }
  if (typeof pattern === 'string' && !compile(pattern, path).test(value)) {
    fail(path, `must match /${pattern}/`);
  }
}

function checkNumber(value: number, schema: Schema, path: string): void {
  const { minimum, maximum } = schema;

  if (typeof minimum === 'number' && value < minimum) {
    fail(path, `must be >= ${minimum}`);
  }
  if (typeof maximum === 'number' && value > maximum) {
    fail(path, `must be <= ${maximum}`);
  }
}

function checkItems(value: unknown[], schema: Schema, path: string): void {
  if (!isPlainObject(schema.items)) return;

  value.forEach((entry, index) =>
    walk(entry, schema.items as Schema, `${path}[${index}]`),
  );
}

function checkObject(
  value: Record<string, unknown>,
  schema: Schema,
  path: string,
): void {
  const properties = isPlainObject(schema.properties) ? schema.properties : {};

  checkRequired(value, schema, path);

  for (const [key, subSchema] of Object.entries(properties)) {
    if (key in value && isPlainObject(subSchema)) {
      walk(value[key], subSchema, `${path}.${key}`);
    }
  }

  if (schema.additionalProperties === false) {
    checkNoExtraProperties(value, properties, path);
  }
}

function checkRequired(
  value: Record<string, unknown>,
  schema: Schema,
  path: string,
): void {
  if (!Array.isArray(schema.required)) return;

  for (const key of schema.required) {
    if (typeof key === 'string' && !(key in value)) {
      fail(path, `"${key}" is required`);
    }
  }
}

function checkNoExtraProperties(
  value: Record<string, unknown>,
  properties: Record<string, unknown>,
  path: string,
): void {
  const extra = Object.keys(value).filter((key) => !(key in properties));
  if (extra.length === 0) return;

  const noun = extra.length === 1 ? 'y' : 'ies';
  fail(path, `unexpected propert${noun} ${extra.join(', ')}`);
}

function compile(pattern: string, path: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    fail(path, `schema has an invalid "pattern": ${pattern}`);
  }
}

function fail(path: string, message: string): never {
  throw new PluginError(`${path}: ${message}`);
}

function matchesType(value: unknown, expected: string): boolean {
  if (expected === 'number') return typeof value === 'number';
  return typeOf(value) === expected;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return false;

  if (Array.isArray(left) || Array.isArray(right)) {
    return arraysEqual(left, right);
  }
  if (typeof left === 'object') {
    return objectsEqual(
      left as Record<string, unknown>,
      right as Record<string, unknown>,
    );
  }
  return false;
}

function arraysEqual(left: unknown, right: unknown): boolean {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;

  return left.every((entry, index) => deepEqual(entry, right[index]));
}

function objectsEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;

  return keys.every((key) => key in right && deepEqual(left[key], right[key]));
}
