import type { ParsedFlow } from '../spec/types.js';

/**
 * What marks a spec value as *naming* an environment variable rather than
 * being one. A value without it is the credential itself.
 */
export const ENV_REF_PREFIX = '$';

/**
 * The fields whose value is read through the environment.
 *
 * Nothing outside this set is resolved: the reference would otherwise be a way
 * to read any variable in the process, which is the whole reason a server
 * refuses `$VAR` in a document it did not write.
 */
const CREDENTIAL_KEYS = new Set(['api_key']);

export function isEnvRef(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(ENV_REF_PREFIX);
}

export function envRefKey(value: string): string {
  return value.slice(ENV_REF_PREFIX.length);
}

/**
 * Every environment variable this flow's credentials name.
 *
 * The whole step tree is walked rather than the places a builtin model sits,
 * because a plugin step carries its own config and a caller asking this
 * question wants the answer for the flow it is about to run, not for the
 * parts of it heddle wrote the types for. Only {@link CREDENTIAL_KEYS} count,
 * so a prompt template that happens to mention a price stays a prompt template.
 *
 * Reading this is not the same as reaching it: a variable named on a branch the
 * run never takes is still in here. Resolution stays where it was — at the
 * first model call — and this only says what that call could ask for.
 */
export function collectEnvRefs(flow: ParsedFlow): string[] {
  const keys = new Set<string>();
  const seen = new WeakSet<object>();

  for (const step of flow.steps) collectFrom(step, keys, seen);
  for (const model of Object.values(flow.models)) collectFrom(model, keys, seen);

  return [...keys];
}

function collectFrom(
  value: unknown,
  keys: Set<string>,
  seen: WeakSet<object>,
): void {
  if (typeof value !== 'object' || value === null) return;
  // A document naming one model from several steps is one object reached
  // several times once names are resolved — same object, one visit.
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) collectFrom(item, keys, seen);
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (CREDENTIAL_KEYS.has(key)) {
      if (isEnvRef(child) && child.length > ENV_REF_PREFIX.length) {
        keys.add(envRefKey(child));
      }
      continue;
    }
    collectFrom(child, keys, seen);
  }
}
