import type { SwitchStep } from '../spec/types.js';
import { State } from '../state/state.js';
import type { NodeExecutor } from './types.js';
import { RunError } from '../errors.js';

/**
 * Branching: read the one reference `on` names, match it against `cases` by
 * string equality, take `else` otherwise. The branch it selects is the target
 * name itself, which is what the derived edges are labelled with.
 *
 * Writes nothing — a switch routes, it does not produce.
 */
export class SwitchExecutor implements NodeExecutor {
  private selected = '';

  constructor(private readonly step: SwitchStep) {}

  branch(): string {
    return this.selected;
  }

  async execute(
    _signal: AbortSignal | undefined,
    input: State,
  ): Promise<State> {
    if (!input.has(this.step.on)) {
      throw new RunError(
        `switch "${this.step.name}": {{${this.step.on}}} has no value in ` +
          `this run — the producer wrote fewer outputs than it declared.`,
      );
    }

    const value = asText(input.get(this.step.on));
    this.selected = Object.hasOwn(this.step.cases, value)
      ? this.step.cases[value]
      : this.step.else;

    return new State({});
  }
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
