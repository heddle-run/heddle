import type { UseStep } from '../spec/types.js';
import { resolveValues } from '../spec/template.js';
import { State } from '../state/state.js';
import type { NodeExecutor } from './types.js';

/**
 * A plugin step: the `with:` block, rendered against the run's state, is what
 * the plugin's executor receives as input. The plugin also sees the raw
 * config on its node — the difference is that the input has this run's
 * values in it, the node has what the document wrote.
 *
 * A plugin node under Weave does not branch: routing belongs to `switch`, so
 * the adapter is built with no declared branches and a plugin that returns
 * one is refused with a message naming that.
 */
export class UseStepExecutor implements NodeExecutor {
  constructor(
    private readonly step: UseStep,
    private readonly adapter: NodeExecutor,
  ) {}

  branch(): string {
    return this.adapter.branch();
  }

  async execute(
    signal: AbortSignal | undefined,
    input: State,
  ): Promise<State> {
    const resolved = resolveValues(
      this.step.config,
      input,
      `step "${this.step.name}"`,
    ) as Record<string, unknown>;

    return this.adapter.execute(signal, new State(resolved));
  }
}
