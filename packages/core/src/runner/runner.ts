import type { CompiledGraph, CompiledNode } from '../graph/types.js';
import { State } from '../state/state.js';
import type { Event } from './events.js';
import type { RunnerOptions } from './options.js';
import { RunError } from '../errors.js';
import { MiddlewareError, type ChainVerdict } from '../plugin/middleware.js';

const UNBRANCHED = '';

type NodeAttempt =
  | { kind: 'produced'; output: State }
  | { kind: 'substituted'; output: State; by: string; cause: Error }
  | { kind: 'retry'; delayMs: number };

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

  private async attemptNode(
    node: CompiledNode,
    input: State,
    attempt: number,
    signal: AbortSignal,
  ): Promise<NodeAttempt> {
    try {
      return { kind: 'produced', output: await node.executor.execute(signal, input) };
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

      return this.applyVerdict(node, failure, attempt, signal);
    }
  }

  private async applyVerdict(
    node: CompiledNode,
    failure: Error,
    attempt: number,
    signal: AbortSignal,
  ): Promise<NodeAttempt> {
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
          kind: 'substituted',
          output: new State(verdict.value),
          by: verdict.by,
          cause: failure,
        };

      case 'fail':
        throw new RunError(
          `"${node.name}" failed and middleware "${verdict.by}" ended the run: ` +
            `${verdict.reason}`,
          { cause: failure },
        );

      default:
        throw failure;
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

    try {
      return await chain.consult(
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
      );
    } catch (err) {
      if (!(err instanceof MiddlewareError)) throw err;
      throw new MiddlewareError(bothFailuresMessage(err.message, error), {
        cause: error,
      });
    }
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

function unroutableSubstitutionMessage(
  by: string,
  nodeName: string,
  cause: Error,
): string {
  return (
    `middleware "${by}" supplied a result for "${nodeName}" ` +
    `after it failed, but the run cannot continue past it: every edge out ` +
    `of "${nodeName}" is labelled with a branch, and a replaced node ` +
    `supplies a result, never a route. Let the error stand for a node that ` +
    `chooses its own branch. Cause: ${cause.message}`
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
