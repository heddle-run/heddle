import type { CompiledGraph, CompiledNode } from '../graph/types.js';
import { State } from '../state/state.js';
import type { Event } from './events.js';
import type { RunnerOptions } from './options.js';
import { RunError } from '../errors.js';
import {
  MiddlewareError,
  type ChainBefore,
  type ChainVerdict,
} from '../plugin/middleware.js';

const UNBRANCHED = '';

type NodeAttempt =
  | { kind: 'produced'; output: State }
  | { kind: 'substituted'; output: State; by: string; cause?: Error }
  | { kind: 'retry'; delayMs: number };

/**
 * What one execution of a node came to, before `node`'s `after` half has seen it.
 *
 * A retry is deliberately not one of these. It is not an outcome but a decision
 * to execute again, and the `node` seam wraps *an execution* — so a retried
 * attempt gets another `before` rather than an `after`.
 */
type Settled =
  | { ok: true; output: State; by?: string; cause?: Error }
  | { ok: false; error: Error };

export class Runner {
  constructor(
    private readonly graph: CompiledGraph,
    private readonly opts: RunnerOptions,
  ) {}

  async run(
    signal: AbortSignal | undefined,
    inputs: Record<string, unknown>,
  ): Promise<State> {
    const signals = [AbortSignal.timeout(this.opts.timeout)];
    if (signal) signals.push(signal);
    return this.walk(AbortSignal.any(signals), inputs);
  }

  private async walk(
    signal: AbortSignal,
    inputs: Record<string, unknown>,
  ): Promise<State> {
    this.emit({ type: 'flow_start' });

    const nodeOutputs = new Map<string, State>();
    let current = this.startNode();
    let carried = new State(inputs);
    let attempt = 1;
    let retries = 0;

    for (let iteration = 0; iteration < this.opts.maxIterations; iteration++) {
      if (signal.aborted) {
        throw new RunError('operation was aborted');
      }

      this.emit({
        type: 'node_start',
        nodeName: current.name,
        nodeType: current.type,
        state: carried,
        attempt,
      });

      const result = await this.attemptNode(
        current,
        this.resolveInputs(current, nodeOutputs, carried),
        attempt,
        signal,
      );

      if (result.kind === 'retry') {
        if (result.delayMs > 0) await sleep(result.delayMs, signal);
        attempt++;
        retries++;
        continue;
      }

      nodeOutputs.set(current.name, result.output);
      this.emit({
        type: 'node_complete',
        nodeName: current.name,
        nodeType: current.type,
        state: result.output,
        attempt,
      });

      if (current.type === 'EndNode') {
        this.emit({ type: 'flow_complete', state: result.output });
        return result.output;
      }

      carried = carried.merge(result.output);
      current = this.advance(current, result);
      attempt = 1;
    }

    throw new RunError(
      exceededIterationsMessage(this.opts.maxIterations, retries),
    );
  }

  private startNode(): CompiledNode {
    const start = this.graph.getNode(this.graph.start);
    if (!start) {
      throw new RunError(`start node "${this.graph.start}" not found`);
    }
    return start;
  }

  /**
   * Run a node once, with whatever the chain has to say on either side of it.
   *
   * Two seams meet here and the nesting is what keeps them apart. `node` wraps
   * an execution: its `before` half decides whether one happens at all, and its
   * `after` half sees what one came to. `nodeError` sits *inside* that, because
   * it is the seam that owns retries — a retry means this execution is being
   * abandoned for another, so it returns before `after` is consulted and the
   * next attempt starts again at `before`.
   *
   * The effect for a middleware author is that `node` is consulted once per
   * settled execution whether the node succeeded or failed, which is what makes
   * it usable for an audit; and that a policy wanting to retry subscribes to
   * `nodeError`, which is the only seam that admits one.
   */
  private async attemptNode(
    node: CompiledNode,
    input: State,
    attempt: number,
    signal: AbortSignal,
  ): Promise<NodeAttempt> {
    const gate = await this.beforeNode(node, input, attempt, signal);

    if (gate.action === 'reject') {
      throw new RunError(rejectedMessage(gate.by, node.name, gate.reason));
    }
    if (gate.action === 'replace') {
      this.warn(node, unrunWarning(gate.by, node.name));
      return this.afterNode(
        node,
        { ok: true, output: new State(gate.value), by: gate.by },
        attempt,
        signal,
      );
    }

    const effective =
      gate.action === 'modify' ? new State(gate.input) : input;

    let settled: Settled;
    try {
      settled = {
        ok: true,
        output: await node.executor.execute(signal, effective),
      };
    } catch (err) {
      const failure = err instanceof Error ? err : new Error(String(err));

      this.emit({
        type: 'node_error',
        nodeName: node.name,
        nodeType: node.type,
        error: failure,
        attempt,
      });

      if (signal.aborted) throw failure;

      const decided = await this.applyVerdict(node, failure, attempt, signal);
      if (decided.kind === 'retry') return decided;
      settled = decided.settled;
    }

    return this.afterNode(node, settled, attempt, signal);
  }

  private async applyVerdict(
    node: CompiledNode,
    failure: Error,
    attempt: number,
    signal: AbortSignal,
  ): Promise<
    { kind: 'retry'; delayMs: number } | { kind: 'settled'; settled: Settled }
  > {
    const verdict = await this.consultMiddleware(node, failure, attempt, signal);

    switch (verdict.action) {
      case 'retry':
        this.warn(
          node,
          retryWarning(
            verdict.by,
            node.name,
            attempt,
            this.opts.maxNodeAttempts,
            verdict.delayMs,
            failure,
          ),
        );
        return { kind: 'retry', delayMs: verdict.delayMs };

      case 'replace':
        this.warn(node, replacementWarning(verdict.by, node.name, failure));
        return {
          kind: 'settled',
          settled: {
            ok: true,
            output: new State(verdict.value),
            by: verdict.by,
            cause: failure,
          },
        };

      case 'fail':
        throw new RunError(
          `"${node.name}" failed and middleware "${verdict.by}" ended the run: ` +
            `${verdict.reason}`,
          { cause: failure },
        );

      default:
        // The error stands as far as `nodeError` is concerned. It is still an
        // outcome, so `node`'s `after` half is asked about it before it is
        // thrown — that is what "consulted whether it succeeded or failed"
        // means, and the seam it belongs to is the one with no `retry`.
        return { kind: 'settled', settled: { ok: false, error: failure } };
    }
  }

  /**
   * Ask the chain what should happen before this node runs.
   *
   * Answers `proceed` whenever nothing subscribes, so the caller has one shape
   * to handle and a run with no middleware never touches the chain. That check
   * matters more here than anywhere else: this is the only seam consulted on
   * every node of every flow.
   */
  private async beforeNode(
    node: CompiledNode,
    input: State,
    attempt: number,
    signal: AbortSignal,
  ): Promise<ChainBefore> {
    const chain = this.opts.middleware;
    if (!chain?.hasBefore('node')) return { action: 'proceed' };

    return this.guarded(node, undefined, () =>
      chain.consultBefore(
        'node',
        { nodeName: node.name, nodeType: node.type },
        input.toData(),
        signal,
        this.opts.eventHandler,
        { attempt, maxAttempts: this.opts.maxNodeAttempts },
      ),
    );
  }

  private async afterNode(
    node: CompiledNode,
    settled: Settled,
    attempt: number,
    signal: AbortSignal,
  ): Promise<NodeAttempt> {
    const chain = this.opts.middleware;
    if (!chain?.has('node')) return stand(settled);

    const verdict = await this.guarded(
      node,
      settled.ok ? undefined : settled.error,
      () =>
        chain.consult(
          'node',
          {
            subject: { nodeName: node.name, nodeType: node.type },
            outcome: settled.ok
              ? { ok: true, value: settled.output.toData() }
              : {
                  ok: false,
                  error: {
                    name: settled.error.name,
                    message: settled.error.message,
                  },
                },
            attempt,
            maxAttempts: this.opts.maxNodeAttempts,
            // `node` admits no retry: the seam that does is inside this one.
            allowRetry: false,
          },
          signal,
          this.opts.eventHandler,
        ),
    );

    switch (verdict.action) {
      case 'replace':
        this.warn(
          node,
          settled.ok
            ? overriddenWarning(verdict.by, node.name)
            : replacementWarning(verdict.by, node.name, settled.error),
        );
        return {
          kind: 'substituted',
          output: new State(verdict.value),
          by: verdict.by,
          cause: settled.ok ? undefined : settled.error,
        };

      case 'fail':
        throw new RunError(
          `"${node.name}" was ended by middleware "${verdict.by}": ` +
            `${verdict.reason}`,
          { cause: settled.ok ? undefined : settled.error },
        );

      default:
        return stand(settled);
    }
  }

  /**
   * Run a consult, and say what the node was doing if the chain itself fails.
   *
   * A middleware failure is fatal — it is the operator's code and swallowing it
   * would apply a policy nobody can see is not being applied. What this adds is
   * the node's own error where there is one, since "the middleware threw" alone
   * sends a reader looking in the wrong place.
   */
  private async guarded<T>(
    node: CompiledNode,
    failure: Error | undefined,
    consult: () => Promise<T>,
  ): Promise<T> {
    try {
      return await consult();
    } catch (err) {
      if (!(err instanceof MiddlewareError) || !failure) throw err;
      throw new MiddlewareError(bothFailuresMessage(err.message, failure), {
        cause: failure,
      });
    }
  }

  private async consultMiddleware(
    node: CompiledNode,
    error: Error,
    attempt: number,
    signal: AbortSignal,
  ): Promise<ChainVerdict> {
    const chain = this.opts.middleware;
    if (!chain?.has('nodeError')) return { action: 'pass' };

    return this.guarded(node, error, () =>
      chain.consult(
        'nodeError',
        {
          subject: { nodeName: node.name, nodeType: node.type },
          outcome: {
            ok: false,
            error: { name: error.name, message: error.message },
          },
          attempt,
          maxAttempts: this.opts.maxNodeAttempts,
          allowRetry: attempt < this.opts.maxNodeAttempts,
        },
        signal,
        this.opts.eventHandler,
      ),
    );
  }

  private advance(current: CompiledNode, result: NodeAttempt): CompiledNode {
    const branch =
      result.kind === 'substituted' ? UNBRANCHED : current.executor.branch();

    const next = this.graph.nextNode(current, branch);
    if (next) return next;

    if (result.kind === 'substituted') {
      throw new RunError(
        unroutableSubstitutionMessage(result.by, current.name, result.cause),
        { cause: result.cause },
      );
    }
    throw new RunError(
      `no next node from "${current.name}" (branch="${branch}")`,
    );
  }

  private resolveInputs(
    node: CompiledNode,
    nodeOutputs: Map<string, State>,
    carried: State,
  ): State {
    if (node.inputMappings.size === 0) return carried;

    const resolved: Record<string, unknown> = {};
    for (const [destinationInput, source] of node.inputMappings) {
      const sourceState = nodeOutputs.get(source.sourceNode);
      if (sourceState?.has(source.sourceOutput)) {
        resolved[destinationInput] = sourceState.get(source.sourceOutput);
      }
    }

    return carried.merge(new State(resolved));
  }

  private warn(node: CompiledNode, message: string): void {
    this.emit({
      type: 'warning',
      nodeName: node.name,
      nodeType: node.type,
      message,
    });
  }

  private emit(event: Event): void {
    this.opts.eventHandler?.(event);
  }
}

/** What the runner does with an outcome nothing wanted to change. */
function stand(settled: Settled): NodeAttempt {
  if (!settled.ok) throw settled.error;

  return settled.by === undefined
    ? { kind: 'produced', output: settled.output }
    : {
        kind: 'substituted',
        output: settled.output,
        by: settled.by,
        cause: settled.cause,
      };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
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

function retryWarning(
  by: string,
  nodeName: string,
  attempt: number,
  maxAttempts: number,
  delayMs: number,
  failure: Error,
): string {
  const delay = delayMs > 0 ? `, in ${delayMs}ms` : '';
  return (
    `"${by}" is retrying "${nodeName}" after it failed ` +
    `(attempt ${attempt} of ${maxAttempts})${delay}. ` +
    `Cause: ${failure.message}`
  );
}

function replacementWarning(
  by: string,
  nodeName: string,
  failure: Error,
): string {
  return (
    `"${by}" supplied a result for "${nodeName}" after it ` +
    `failed, so the run continues. The node did not produce this. ` +
    `Cause: ${failure.message}`
  );
}

function rejectedMessage(by: string, nodeName: string, reason: string): string {
  return (
    `middleware "${by}" would not let "${nodeName}" run: ${reason}. ` +
    `A middleware is installed by whoever runs heddle and is named nowhere in ` +
    `the flow, so this is not a fault in the document.`
  );
}

function unrunWarning(by: string, nodeName: string): string {
  return (
    `"${by}" supplied a result for "${nodeName}" instead of letting it run, ` +
    `so the node did not execute at all.`
  );
}

function overriddenWarning(by: string, nodeName: string): string {
  return (
    `"${by}" replaced what "${nodeName}" produced. The run continues with the ` +
    `middleware's value, and the node's own output is gone.`
  );
}

function unroutableSubstitutionMessage(
  by: string,
  nodeName: string,
  cause: Error | undefined,
): string {
  const why = cause
    ? ` Cause: ${cause.message}`
    : ` Nothing failed here — the middleware supplied a result for a node that ` +
      `routes, which is the one case a result cannot answer.`;

  return (
    `middleware "${by}" supplied a result for "${nodeName}", ` +
    `but the run cannot continue past it: every edge out ` +
    `of "${nodeName}" is labelled with a branch, and a replaced node ` +
    `supplies a result, never a route. Let the node run for one that ` +
    `chooses its own branch.${why}`
  );
}

function exceededIterationsMessage(
  maxIterations: number,
  retries: number,
): string {
  const retryNote =
    retries > 0
      ? `, ${retries} of which were middleware retries of a failing node. ` +
        `The graph may be fine; something in it is failing repeatedly.`
      : '';
  return `exceeded max iterations (${maxIterations})${retryNote}`;
}

function bothFailuresMessage(
  middlewareMessage: string,
  nodeError: Error,
): string {
  return (
    `${middlewareMessage}\n` +
    `The node's own failure, which is what the middleware was asked about: ` +
    `${nodeError.message}\n` +
    `A middleware is installed by whoever runs heddle and is named nowhere in ` +
    `the flow, so this is not a fault in the document — it is removed the same ` +
    `way it was loaded.`
  );
}
