import type { CompiledGraph, CompiledNode } from '../graph/types.js';
import { State } from '../state/state.js';
import type { Event } from './events.js';
import type { RunnerOptions, RunPosition } from './options.js';
import { RunSuspended, isSuspended, readResume } from '../session/suspend.js';
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

  /**
   * Walk the graph, from the start or from where a previous run stopped.
   *
   * `from` is the whole of resuming. Everything the walk carries is restored
   * from it — the node to enter, the state accumulated so far, and the outputs
   * earlier nodes produced, which is what the data-flow edges resolve against.
   * A resumed run is not a special mode; it is the same loop entered in the
   * middle.
   */
  async run(
    signal: AbortSignal | undefined,
    inputs: Record<string, unknown>,
    from?: RunPosition,
  ): Promise<State> {
    const signals = [AbortSignal.timeout(this.opts.timeout)];
    if (signal) signals.push(signal);
    return this.walk(AbortSignal.any(signals), inputs, from);
  }

  private async walk(
    signal: AbortSignal,
    inputs: Record<string, unknown>,
    from: RunPosition | undefined,
  ): Promise<State> {
    this.emit({ type: 'flow_start' });

    const nodeOutputs = restoredOutputs(from);
    let current = from ? this.resumeNode(from.node) : this.startNode();
    // On a resume the checkpoint supplies the state and `inputs` is layered
    // over it, rather than replacing it. That layer is how an answer reaches
    // the node that asked for one — the runner puts it in the state and never
    // looks at it, which is what keeps `_resume` the executor's business.
    let carried = new State(from ? { ...from.carried, ...inputs } : inputs);
    let attempt = from?.attempt ?? 1;
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

      const result = await this.attemptOrSuspend(
        current,
        carried,
        nodeOutputs,
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
        // Cleared before the answer is handed back, so a caller that reads the
        // session on seeing the result never finds a checkpoint for a run that
        // is already over — which `openTurn` would refuse the next message for.
        await this.opts.checkpoints?.clear();
        return result.output;
      }

      carried = carried.merge(result.output);
      current = this.advance(current, result);
      attempt = 1;

      // After advancing, so what is recorded is where to *resume* rather than
      // what just ran. A checkpoint naming the node that finished would re-run
      // it, and a node that already called a tool is not free to run twice.
      await this.checkpoint(current, carried, nodeOutputs);
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
   * The node a checkpoint names, in the graph being resumed with.
   *
   * Missing means the flow changed under the checkpoint — a node was renamed or
   * removed between the run stopping and somebody continuing it. Worth its own
   * message, because "no such node" against a graph the caller just supplied
   * reads as a bad flow rather than as a stale checkpoint.
   */
  private resumeNode(name: string): CompiledNode {
    const node = this.graph.getNode(name);
    if (!node) {
      throw new RunError(
        `cannot resume at "${name}": this flow has no such node. The ` +
          `checkpoint was written by a run of a different version of ` +
          `"${this.graph.name}" — resume against the flow it stopped in, or ` +
          `delete the checkpoint and start the turn again.`,
      );
    }
    return node;
  }

  private async checkpoint(
    next: CompiledNode,
    carried: State,
    nodeOutputs: Map<string, State>,
  ): Promise<void> {
    const sink = this.opts.checkpoints;
    if (!sink || !this.opts.durable) return;

    await sink.save(positionAt(next.name, carried, nodeOutputs, 1));
  }

  /**
   * Attempt a node, and write the run down if a middleware stopped it.
   *
   * The checkpoint names *this* node rather than the next one — a suspension is
   * not a boundary crossed, it is a node that has not finished — and it carries
   * the executor's own bookmark, which is what lets the node be re-entered
   * partway through rather than from the top.
   *
   * A suspension with nowhere to write is refused here rather than at the seam.
   * The middleware did nothing wrong: it is the run that has no session, and
   * the person who has to hear about it is whoever started it that way.
   */
  private async attemptOrSuspend(
    node: CompiledNode,
    carried: State,
    nodeOutputs: Map<string, State>,
    attempt: number,
    signal: AbortSignal,
  ): Promise<NodeAttempt> {
    try {
      return await this.attemptNode(
        node,
        this.resolveInputs(node, nodeOutputs, carried),
        attempt,
        signal,
      );
    } catch (err) {
      if (!isSuspended(err)) throw err;

      const sink = this.opts.checkpoints;
      if (!sink) {
        throw new RunError(unresumableMessage(err.suspension.by, node.name), {
          cause: err,
        });
      }

      await sink.suspend(
        positionAt(node.name, carried, nodeOutputs, attempt),
        err.suspension,
      );
      throw err;
    }
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
    if (gate.action === 'suspend') {
      // No bookmark: nothing in this node has run, so re-entering it from the
      // top *is* resuming. The answer reaches the node as `_resume` in its
      // input, which is where a node type that wants one looks.
      throw new RunSuspended({
        by: gate.by,
        seam: 'node',
        ask: gate.ask,
        node: node.name,
        resume: {},
      });
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
      // A suspension is not an outcome this seam has anything to say about.
      // Emitting `node_error` would report a run that stopped on purpose as a
      // failure, and consulting `nodeError` would offer a middleware the chance
      // to retry a node that is waiting on a person.
      if (isSuspended(err)) throw err;

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

    // The answer, when this node is the one a suspension is being resumed into.
    // Without it a gate here has no way to tell "asked again, and here is what
    // they said" from "asked for the first time", and would suspend forever.
    // `toolCall` needs no equivalent: its bookmark replays the answer as the
    // call's result, so that gate is never consulted a second time.
    const resumed = readResume(input, node.name);

    return this.guarded(node, undefined, () =>
      chain.consultBefore(
        'node',
        { nodeName: node.name, nodeType: node.type },
        input.toData(),
        signal,
        this.opts.eventHandler,
        { attempt, maxAttempts: this.opts.maxNodeAttempts },
        resumed?.answer,
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

function positionAt(
  node: string,
  carried: State,
  nodeOutputs: Map<string, State>,
  attempt: number,
): RunPosition {
  return {
    node,
    carried: carried.toData(),
    nodeOutputs: Object.fromEntries(
      [...nodeOutputs].map(([name, state]) => [name, state.toData()]),
    ),
    attempt,
  };
}

function unresumableMessage(by: string, nodeName: string): string {
  return (
    `middleware "${by}" suspended "${nodeName}" to wait on a human, but this ` +
    `run has nowhere to be written down — so there would be no way to answer ` +
    `it. Run it in a session (--session on the CLI, "session" in a request), ` +
    `which is where a suspended run waits.`
  );
}

function restoredOutputs(from: RunPosition | undefined): Map<string, State> {
  if (!from) return new Map();

  return new Map(
    Object.entries(from.nodeOutputs).map(([name, data]) => [
      name,
      new State(data),
    ]),
  );
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
