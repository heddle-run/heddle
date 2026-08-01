/**
 * The state keys heddle claims for itself.
 *
 * Two, and they are the same shape of thing: something the run needs that the
 * flow did not put there. `_chat_history` carries the conversation before this
 * run; `_resume` carries what a suspended executor left behind, handed back
 * when somebody answers.
 *
 * Underscored, refused as flow-declared names by `validate`, and stripped from
 * the message an agent builds — a flow should be able to be read without
 * knowing these exist.
 */
export const CHAT_HISTORY_KEY = '_chat_history';

export const RESUME_KEY = '_resume';

export const RESERVED_STATE_KEYS: readonly string[] = [
  CHAT_HISTORY_KEY,
  RESUME_KEY,
];

export function isReservedStateKey(key: string): boolean {
  return RESERVED_STATE_KEYS.includes(key);
}

/** Everything but the keys heddle put there — what an agent shows the model. */
export function withoutReserved(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const rest = { ...data };
  for (const key of RESERVED_STATE_KEYS) delete rest[key];
  return rest;
}
