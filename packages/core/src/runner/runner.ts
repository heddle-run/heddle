import type { CompiledGraph, CompiledNode } from '../graph/types.js';
import { State } from '../state/state.js';
import type { Event } from './events.js';
import type { RunnerOptions } from './options.js';
import { RunError } from '../errors.js';
import { MiddlewareError, type ChainVerdict } from '../plugin/middleware.js';

export class Runner {
  constructor(
    private graph: CompiledGraph,
    private opts: RunnerOptions,
  ) {}

  async run(
    signal: AbortSignal | undefined,
    inputs: Record<string, unknown>,
  ): Promise<State> {
    const signals = [AbortSignal.timeout(this.opts.timeout)];
    if (signal) signals.push(signal);
    return this._run(AbortSignal.any(signals), inputs);
  }

  private async _run(
    signal: AbortSignal,
    inputs: Record<string, unknown>,
  ): Promise<State> {
    this.emit({ type: 'flow_start' });

    const nodeOutputs = new Map<string, State>();

    const startNode = this.graph.getNode(this.graph.start);
    if (!startNode) {
      throw new RunError(`start node "${this.graph.start}" not found`);
    }

    let current: CompiledNode = startNode;
    let currentState = new State(inputs);

    // Which attempt at `current` this is, and how many of the loop's iterations
    // have been spent re-attempting rather than advancing. The second is only
    // for the message at the bottom: "exceeded max iterations" sends whoever
    // reads it to the graph, and a flow whose tools were flaky that morning has
    // nothing wrong with its graph.
    let attempt = 1;
    let retried = 0;

    for (
      let iteration = 0;
      iteration < this.opts.maxIterations;
      iteration++
    ) {
      if (signal.aborted) {
        throw new RunError('operation was aborted');
      }

      this.emit({
        type: 'node_start',
        nodeName: current.name,
        nodeType: current.type,
        state: currentState,
        attempt,
      });

      const nodeInput = this.resolveInputs(
        current,
        nodeOutputs,
        currentState,
      );

      let output: State;
      /**
       * True when this node did not run and its output was supplied for it.
       *
       * It decides how the node is routed. `executor.branch()` reads state the
       * executor wrote on its last *successful* run and never resets —
       * `PluginNodeAdapter._branch` and `SwitchNode`'s are both assigned only at
       * the end of a successful execute — so consulting it after a failure
       * returns the branch from a previous visit, and a substituted node inside
       * a loop would follow an edge that has nothing to do with this visit. A
       * replaced node therefore takes the unbranched edge, which is also the
       * honest answer: a middleware supplies a result, never a route, because
       * `graph/validate.ts` checked reachability before anything ran.
       */
      let substituted: { by: string; cause: Error } | undefined;

      try {
        output = await current.executor.execute(signal, nodeInput);
      } catch (err) {
        const execErr =
          err instanceof Error ? err : new Error(String(err));
        this.emit({
          type: 'node_error',
          nodeName: current.name,
          nodeType: current.type,
          error: execErr,
          attempt,
        });

        // An aborted run is not a node failure anyone should be asked about.
        // The node threw *because* the run ended — a client hung up, or the
        // wall-clock budget expired — so there is nothing to retry into and no
        // policy that applies. Consulting anyway also charges the failure to
        // the wrong party: `PluginHost.call` refuses a call made on an aborted
        // signal, the chain reads any throw as the middleware failing, and the
        // run would end with a `MiddlewareError` blaming the operator's plugin
        // for heddle's own cancellation.
        if (signal.aborted) throw execErr;

        const verdict = await this.onNodeError(current, execErr, attempt, signal);

        if (verdict.action === 'retry') {
          // `continue` runs the loop's update, so a retry spends an iteration.
          // That is what keeps `maxIterations` the real bound on how many times
          // anything executes, rather than a bound on graph progress that a
          // retry loop could sit underneath forever.
          this.emit({
            type: 'warning',
            nodeName: current.name,
            nodeType: current.type,
            message:
              `"${verdict.by}" is retrying "${current.name}" after it failed ` +
              `(attempt ${attempt} of ${this.opts.maxNodeAttempts})` +
              `${verdict.delayMs > 0 ? `, in ${verdict.delayMs}ms` : ''}. ` +
              `Cause: ${execErr.message}`,
          });
          if (verdict.delayMs > 0) await sleep(verdict.delayMs, signal);
          attempt++;
          retried++;
          continue;
        }

        if (verdict.action === 'replace') {
          this.emit({
            type: 'warning',
            nodeName: current.name,
            nodeType: current.type,
            message:
              `"${verdict.by}" supplied a result for "${current.name}" after it ` +
              `failed, so the run continues. The node did not produce this. ` +
              `Cause: ${execErr.message}`,
          });
          output = new State(verdict.value);
          substituted = { by: verdict.by, cause: execErr };
        } else if (verdict.action === 'fail') {
          throw new RunError(
            `"${current.name}" failed and middleware "${verdict.by}" ended the run: ` +
              `${verdict.reason}`,
            { cause: execErr },
          );
        } else {
          throw execErr;
        }
      }

      nodeOutputs.set(current.name, output);

      this.emit({
        type: 'node_complete',
        nodeName: current.name,
        nodeType: current.type,
        state: output,
        attempt,
      });

      if (current.type === 'EndNode') {
        this.emit({ type: 'flow_complete', state: output });
        return output;
      }

      currentState = currentState.merge(output);

      const branch = substituted ? '' : current.executor.branch();
      const next = this.graph.nextNode(current, branch);
      if (!next) {
        // A substituted node that cannot be routed is a different failure from
        // a graph with a missing edge, and reported as one. `graph/validate.ts`
        // requires every non-terminal node to have *an* edge, never an
        // unbranched one, so a BranchingNode's edges are all labelled and there
        // is nothing for a replaced node to take — the shape `examples/` ships.
        // Reported as "no next node" it would send whoever reads it to the
        // graph, which is fine, for a decision the middleware made.
        if (substituted) {
          throw new RunError(
            `middleware "${substituted.by}" supplied a result for "${current.name}" ` +
              `after it failed, but the run cannot continue past it: every edge out ` +
              `of "${current.name}" is labelled with a branch, and a replaced node ` +
              `supplies a result, never a route. Let the error stand for a node that ` +
              `chooses its own branch. Cause: ${substituted.cause.message}`,
            { cause: substituted.cause },
          );
        }
        throw new RunError(
          `no next node from "${current.name}" (branch="${branch}")`,
        );
      }

      current = next;
      attempt = 1;
    }

    throw new RunError(
      `exceeded max iterations (${this.opts.maxIterations})` +
        (retried > 0
          ? `, ${retried} of which were middleware retries of a failing node. ` +
            `The graph may be fine; something in it is failing repeatedly.`
          : ''),
    );
  }

  /**
   * Ask the middleware chain what to do about a node that threw.
   *
   * Returns `pass` — the error stands — whenever nothing is installed, nothing
   * subscribes, or the ceiling is spent, so the caller has one shape to handle
   * and the no-middleware path is the path this method is not on.
   *
   * At the ceiling the chain is still consulted, and the ceiling is handed
   * *into* it rather than applied to what comes out. The difference decides
   * whether the ordinary two-plugin arrangement works: a retry policy and a
   * fallback, where the retry policy is consulted first and asks for a retry it
   * can no longer have. Applied to the result, that answer would come back as
   * `pass` for the whole consult and the fallback — which had a canned result
   * ready for exactly this attempt — would never be asked. Handed in, the
   * refusal lands on the one entry that asked and the chain carries on.
   *
   * A refused retry is a limit rather than a middleware failure, so it is a
   * warning and never a `MiddlewareError`, which would blame the plugin for
   * heddle's ceiling.
   */
  private async onNodeError(
    node: CompiledNode,
    error: Error,
    attempt: number,
    signal: AbortSignal,
  ): Promise<ChainVerdict> {
    const chain = this.opts.middleware;
    if (!chain || !chain.has('nodeError')) return { action: 'pass' };

    try {
      return await chain.consult(
        'nodeError',
        {
          subject: { nodeName: node.name, nodeType: node.type },
          outcome: { ok: false, error: { name: error.name, message: error.message } },
          attempt,
          maxAttempts: this.opts.maxNodeAttempts,
          allowRetry: attempt < this.opts.maxNodeAttempts,
        },
        signal,
        this.opts.eventHandler,
      );
    } catch (err) {
      // Two failures now, and whoever reads this has to be told both. The
      // middleware's is why the run ends *here*; the node's is what the flow
      // was actually doing, and it is the one its author can act on — they did
      // not install the middleware and may not know it exists. Reported alone,
      // either one sends somebody to the wrong file.
      if (!(err instanceof MiddlewareError)) throw err;
      throw new MiddlewareError(
        `${err.message}\n` +
          `The node's own failure, which is what the middleware was asked about: ` +
          `${error.message}\n` +
          `A middleware is installed by whoever runs heddle and is named nowhere in ` +
          `the flow, so this is not a fault in the document — it is removed the same ` +
          `way it was loaded.`,
        { cause: error },
      );
    }
  }

  private resolveInputs(
    cn: CompiledNode,
    nodeOutputs: Map<string, State>,
    currentState: State,
  ): State {
    if (cn.inputMappings.size === 0) {
      return currentState;
    }

    // Build resolved data in one shot to avoid chained State allocations
    const resolvedData: Record<string, unknown> = {};
    for (const [destInput, src] of cn.inputMappings) {
      const srcOutput = nodeOutputs.get(src.sourceNode);
      if (srcOutput?.has(src.sourceOutput)) {
        resolvedData[destInput] = srcOutput.get(src.sourceOutput);
      }
    }

    return currentState.merge(new State(resolvedData));
  }

  private emit(e: Event): void {
    this.opts.eventHandler?.(e);
  }
}

/**
 * Wait, unless the run ends first.
 *
 * Resolves on abort rather than rejecting, because the caller does not need to
 * know: it `continue`s straight into the loop's own `signal.aborted` check,
 * which reports the abort in the run's terms. Rejecting here would produce a
 * second way to say the same thing, from inside a retry delay, where it would
 * read as the retry having failed.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // Checked before the listener is added, because a listener on a signal that
    // has already aborted never fires — the same hazard `PluginHost.call`
    // guards at its own entry. Without this an abort that arrived while the
    // chain was being consulted would be discovered only after the full delay,
    // so a run whose caller hung up would sit here for up to MAX_RETRY_DELAY
    // holding its concurrency slot.
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
