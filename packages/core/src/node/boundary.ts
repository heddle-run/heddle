/**
 * The two synthetic nodes every graph gets: `inputs`, where a run's values
 * come in, and one node per outcome, where they go out. Neither exists in the
 * document as a step — flow `inputs` and `outcomes` lower to these.
 */

import {
  OUTCOME_KEY,
  type Outcome,
  type SchemaMap,
} from '../spec/types.js';
import { resolveValues } from '../spec/template.js';
import { State } from '../state/state.js';
import type { NodeExecutor } from './types.js';
import { RESERVED_STATE_KEYS } from '../session/reserved.js';
import { RunError } from '../errors.js';

/**
 * Checks the run was given what the document declares, fills defaults, and
 * passes everything through — its output is what `{{inputs.x}}` reads.
 */
export class InputsExecutor implements NodeExecutor {
  constructor(private readonly inputs: SchemaMap) {}

  branch(): string {
    return '';
  }

  async execute(
    _signal: AbortSignal | undefined,
    input: State,
  ): Promise<State> {
    let state = input.clone();
    const missing: string[] = [];

    for (const [field, schema] of Object.entries(this.inputs)) {
      if (state.has(field)) continue;
      if (schema.default !== undefined) {
        state = state.set(field, schema.default);
        continue;
      }
      missing.push(field);
    }

    if (missing.length > 0) {
      throw new RunError(
        `this flow requires input${missing.length === 1 ? '' : 's'} ` +
          `${missing.map((name) => `"${name}"`).join(', ')} — pass them with ` +
          `--input '{"${missing[0]}": ...}' or the request's "input".`,
      );
    }

    return state;
  }
}

/**
 * Builds what the run returns: the outcome's payload rendered against the
 * state, plus the outcome's own name under `outcome`.
 *
 * A payload-less outcome — the implicit `done` — echoes what the run
 * accumulated, minus heddle's reserved keys and the dotted keys that carried
 * references between nodes. For the one-agent flow that is exactly the
 * agent's own output, which is what "the flow returns the last step's
 * outputs" means.
 */
export class OutcomeExecutor implements NodeExecutor {
  constructor(private readonly outcome: Outcome) {}

  branch(): string {
    return '';
  }

  async execute(
    _signal: AbortSignal | undefined,
    input: State,
  ): Promise<State> {
    const payload =
      this.outcome.payload !== undefined
        ? (resolveValues(
            this.outcome.payload,
            input,
            `outcome "${this.outcome.name}"`,
          ) as Record<string, unknown>)
        : echoed(input);

    return new State({ ...payload, [OUTCOME_KEY]: this.outcome.name });
  }
}

function echoed(input: State): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const key of input.keys()) {
    if (key.includes('.')) continue;
    if (RESERVED_STATE_KEYS.includes(key)) continue;
    if (key === OUTCOME_KEY) continue;
    data[key] = input.get(key);
  }
  return data;
}
