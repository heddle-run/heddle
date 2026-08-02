import { snakeToCamel } from 'agentspec';
import { PluginError } from '../errors.js';
import type { Dependencies } from '../node/types.js';
import type { EventHandler } from '../runner/events.js';
import { pluginReporter } from './executor.js';
import {
  readAfterVerdict,
  readBeforeVerdict,
  type AfterVerdict,
  type BeforeVerdict,
} from './protocol.js';
import type { PluginRegistry, RegisteredMiddleware } from './registry.js';
import { PluginModel, toolRunner, type ToolRunner } from './services.js';
import { readSubscription, type Seam } from './seams.js';
import type {
  MiddlewareContext,
  MiddlewareSubject,
  PluginMiddlewareExecutor,
  SeamOutcome,
} from './types.js';

export const MAX_RETRY_DELAY = 30_000;

export class MiddlewareError extends PluginError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MiddlewareError';
  }
}

export type ChainVerdict =
  | { action: 'pass' }
  | { action: 'replace'; value: Record<string, unknown>; by: string }
  | { action: 'retry'; delayMs: number; by: string }
  | { action: 'fail'; reason: string; by: string };

/**
 * What the whole chain decided before a call site acted.
 *
 * `modify` carries no `by`, and that is not an omission. A replacement or a
 * rejection is one middleware's decision and is reported as such; a modification
 * may have passed through several, each rewriting what the next one saw, so
 * there is no single author to name.
 */
export type ChainBefore =
  | { action: 'proceed' }
  | { action: 'modify'; input: Record<string, unknown> }
  | { action: 'replace'; value: Record<string, unknown>; by: string }
  | { action: 'reject'; reason: string; by: string }
  | { action: 'suspend'; ask: Record<string, unknown>; by: string };

export interface ConsultInput {
  subject: MiddlewareSubject;
  outcome: SeamOutcome;
  attempt: number;
  maxAttempts: number;
  allowRetry?: boolean;
}

interface Entry {
  plugin: string;
  componentType: string;
  before: Set<Seam>;
  after: Set<Seam>;
  impl: PluginMiddlewareExecutor;
  config: Record<string, unknown>;
  model: PluginModel;
  runTool: ToolRunner;
}

export class MiddlewareChain {
  private constructor(private readonly entries: Entry[]) {}

  static empty(): MiddlewareChain {
    return new MiddlewareChain([]);
  }

  static build(
    registry: PluginRegistry | undefined,
    deps: Dependencies,
    config: Record<string, Record<string, unknown>> = {},
  ): MiddlewareChain {
    const defs = registry?.middlewareDefs() ?? [];
    const entries = defs.map((registered) =>
      buildEntry(registered, config, deps),
    );

    checkUnclaimed(
      config,
      defs.map(({ def }) => def.componentType),
    );

    return new MiddlewareChain(entries);
  }

  isEmpty(): boolean {
    return this.entries.length === 0;
  }

  has(seam: Seam): boolean {
    return this.entries.some((entry) => entry.after.has(seam));
  }

  /**
   * Whether anything subscribes to this seam's `before` half.
   *
   * Separate from {@link has} because the halves are subscribed to separately,
   * and a call site asking the wrong question would consult a chain that has
   * nothing to say — a round trip per tool call, on the path where it is least
   * affordable.
   */
  hasBefore(seam: Seam): boolean {
    return this.entries.some((entry) => entry.before.has(seam));
  }

  describe(): string[] {
    return this.entries.map(
      (entry) =>
        `${entry.componentType} (${entry.plugin}) on ${[...entry.after].join(', ')}`,
    );
  }

  async consult(
    seam: Seam,
    input: ConsultInput,
    signal: AbortSignal | undefined,
    handler: EventHandler | undefined,
  ): Promise<ChainVerdict> {
    let refusedRetryReported = false;

    for (const entry of this.inConsultOrder(seam)) {
      const verdict = await this.ask(entry, seam, input, signal, handler);

      switch (verdict.action) {
        case 'pass':
          continue;

        case 'replace':
          return {
            action: 'replace',
            value: verdict.value,
            by: entry.componentType,
          };

        case 'retry': {
          if (input.allowRetry === false) {
            if (!refusedRetryReported) {
              refusedRetryReported = true;
              warnRetryRefused(handler, whereOf(entry), input);
            }
            continue;
          }
          return {
            action: 'retry',
            delayMs: clampDelay(
              verdict.delayMs ?? 0,
              whereOf(entry),
              handler,
              input.subject,
            ),
            by: entry.componentType,
          };
        }

        case 'fail':
          return {
            action: 'fail',
            reason: verdict.reason,
            by: entry.componentType,
          };
      }
    }

    return { action: 'pass' };
  }

  /**
   * Ask, in order, what should happen before a call site acts.
   *
   * The `after` chain's shape with one difference that matters: `modify` does
   * not stop the walk. A verdict that replaces, rejects or fails ends it,
   * because each of those settles what happens; a `modify` only changes what the
   * next middleware is deciding about, so the chain carries on with the new
   * input. That is what lets a redactor and an approval gate compose — the
   * redactor rewrites the arguments and the gate then sees what would actually
   * run, rather than what the model first asked for.
   */
  async consultBefore(
    seam: Seam,
    subject: MiddlewareSubject,
    input: Record<string, unknown>,
    signal: AbortSignal | undefined,
    handler: EventHandler | undefined,
    /**
     * Which attempt this is, where the call site has an attempt loop that
     * re-enters the `before` half.
     *
     * Only `node` does: a retried node is executed again, so it is asked again,
     * and a cache that served the first attempt should know not to serve the
     * second. `toolCall` and `modelCall` consult once and then loop *inside*
     * that, so 1 is the truth for them rather than a default standing in for
     * one. `agentRound` is asked once a round, and a round is different work
     * rather than the same work again, so it carries its number in `input`.
     */
    attempts: { attempt: number; maxAttempts: number } = {
      attempt: 1,
      maxAttempts: 1,
    },
    /** Set when this consultation is a `node` suspension being resumed. */
    answered?: Record<string, unknown>,
  ): Promise<ChainBefore> {
    let current = input;

    for (const entry of this.beforeOrder(seam)) {
      const verdict = await this.askBefore(
        entry,
        seam,
        subject,
        current,
        signal,
        handler,
        attempts,
        answered,
      );

      switch (verdict.action) {
        case 'proceed':
          continue;
        case 'modify':
          current = verdict.input;
          continue;
        case 'replace':
          return {
            action: 'replace',
            value: verdict.value,
            by: entry.componentType,
          };
        case 'reject':
          return {
            action: 'reject',
            reason: verdict.reason,
            by: entry.componentType,
          };
        case 'suspend':
          // Like a rejection, this ends the consultation: the middleware after
          // this one would be deciding about work that is no longer going to
          // happen on this pass. It gets asked again when the run resumes.
          return {
            action: 'suspend',
            ask: verdict.ask,
            by: entry.componentType,
          };
      }
    }

    return current === input
      ? { action: 'proceed' }
      : { action: 'modify', input: current };
  }

  private beforeOrder(seam: Seam): Entry[] {
    return [...this.entries].reverse().filter((entry) => entry.before.has(seam));
  }

  private async askBefore(
    entry: Entry,
    seam: Seam,
    subject: MiddlewareSubject,
    input: Record<string, unknown>,
    signal: AbortSignal | undefined,
    handler: EventHandler | undefined,
    attempts: { attempt: number; maxAttempts: number },
    answered: Record<string, unknown> | undefined,
  ): Promise<BeforeVerdict> {
    const where = whereOf(entry);

    // Subscribed to the half and serving no handler. Caught here rather than at
    // build time because an in-process def is a plain object whose `before` is
    // optional, and the remote def always has one — so this is the only place
    // both shapes meet.
    if (!entry.impl.before) {
      throw new MiddlewareError(
        `${where} subscribes to the "before" half of "${seam}" but provides no ` +
          `before handler.`,
      );
    }

    try {
      const context = this.contextFor(
        entry,
        seam,
        {
          subject,
          outcome: { ok: true, value: undefined },
          attempt: attempts.attempt,
          maxAttempts: attempts.maxAttempts,
        },
        signal,
        handler,
      );
      if (answered !== undefined) context.answered = answered;

      const verdict = await entry.impl.before({ subject, input }, context);
      // Checked whichever side it came from. An in-process middleware is a plain
      // object whose return value TypeScript saw at compile time and nothing has
      // seen since — the same reason `ask` reads its `after` verdicts back.
      return readBeforeVerdict(seam, verdict, where);
    } catch (err) {
      if (err instanceof MiddlewareError) throw err;
      const detail = err instanceof Error ? err.message : String(err);
      throw new MiddlewareError(
        `${where} failed while heddle was consulting it on ${seam}: ${detail}`,
        { cause: err instanceof Error ? err : undefined },
      );
    }
  }

  private inConsultOrder(seam: Seam): Entry[] {
    return [...this.entries].reverse().filter((entry) => entry.after.has(seam));
  }

  private async ask(
    entry: Entry,
    seam: Seam,
    input: ConsultInput,
    signal: AbortSignal | undefined,
    handler: EventHandler | undefined,
  ): Promise<AfterVerdict> {
    const where = whereOf(entry);

    try {
      const verdict = await entry.impl.after(
        { subject: input.subject, outcome: input.outcome },
        this.contextFor(entry, seam, input, signal, handler),
      );
      return readAfterVerdict(seam, verdict, where);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new MiddlewareError(
        `${where} failed while heddle was consulting it on ${seam}: ${detail}`,
        { cause: err },
      );
    }
  }

  private contextFor(
    entry: Entry,
    seam: Seam,
    input: ConsultInput,
    signal: AbortSignal | undefined,
    handler: EventHandler | undefined,
  ): MiddlewareContext {
    return {
      signal,
      seam,
      component: entry.config,
      attempt: input.attempt,
      maxAttempts: input.maxAttempts,
      runTool: entry.runTool,
      callModel: entry.model.bind(signal),
      ...pluginReporter(handler, {
        nodeName: input.subject.nodeName ?? entry.componentType,
        componentType: entry.componentType,
      }),
    };
  }
}

/**
 * Check middleware configuration without instantiating any middleware.
 *
 * The two things about a configuration that are knowable before a run exists:
 * that something claims it, and that it matches the schema its plugin declared.
 * A server checks both while it is still starting, so an operator's mistyped
 * `--plugin-config` is a boot failure rather than a 500 on whichever request
 * first builds a chain — by which time the port has been open for hours and the
 * caller sees an error about a decision they had no part in.
 *
 * {@link MiddlewareChain.build} does both of these itself, so a host with
 * nowhere earlier to put them loses nothing by not calling this.
 */
export function checkMiddlewareConfig(
  registry: PluginRegistry | undefined,
  config: Record<string, Record<string, unknown>>,
): void {
  const defs = registry?.middlewareDefs() ?? [];

  checkUnclaimed(
    config,
    defs.map(({ def }) => def.componentType),
  );

  for (const { def } of defs) {
    def.validateConfig?.(normalize(ownConfig(config, def.componentType)));
  }
}

function buildEntry(
  { plugin, def }: RegisteredMiddleware,
  config: Record<string, Record<string, unknown>>,
  deps: Dependencies,
): Entry {
  const where = `middleware "${def.componentType}" (plugin "${plugin}")`;
  const own = normalize(ownConfig(config, def.componentType));

  const seams = readSubscription(where, def.seams);
  def.validateConfig?.(own);

  return {
    plugin,
    componentType: def.componentType,
    before: new Set(
      (Object.keys(seams) as Seam[]).filter((seam) =>
        seams[seam]?.includes('before'),
      ),
    ),
    after: new Set(
      (Object.keys(seams) as Seam[]).filter((seam) =>
        seams[seam]?.includes('after'),
      ),
    ),
    impl: def.createMiddleware(own, deps),
    config: own,
    model: new PluginModel(where, own, deps),
    runTool: toolRunner(where, deps),
  };
}

function ownConfig(
  config: Record<string, Record<string, unknown>>,
  componentType: string,
): Record<string, unknown> {
  return Object.hasOwn(config, componentType) ? config[componentType] : {};
}

function whereOf(entry: Entry): string {
  return `middleware "${entry.componentType}" (plugin "${entry.plugin}")`;
}

function checkUnclaimed(
  config: Record<string, Record<string, unknown>>,
  provided: string[],
): void {
  const claimed = new Set(provided);

  for (const componentType of Object.keys(config)) {
    if (claimed.has(componentType)) continue;
    throw new PluginError(unclaimedConfigMessage(componentType, provided));
  }
}

function normalize(config: Record<string, unknown>): Record<string, unknown> {
  const raw = config.llm_config;
  if (raw === undefined || config.llmConfig !== undefined) return config;

  return { ...config, llmConfig: camelize(raw) };
}

function camelize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelize);
  if (typeof value !== 'object' || value === null) return value;

  const camelized: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    camelized[snakeToCamel(key)] = camelize(nested);
  }
  return camelized;
}

function clampDelay(
  requested: number,
  where: string,
  handler: EventHandler | undefined,
  subject: MiddlewareSubject,
): number {
  const delay = Math.max(0, Math.min(requested, MAX_RETRY_DELAY));
  if (delay === requested) return delay;

  handler?.({
    type: 'warning',
    nodeName: subject.nodeName ?? '',
    message:
      `${where} asked to wait ${requested}ms before retrying; heddle waits ` +
      `${delay}ms. A delay is time the run spends doing nothing, and the run's ` +
      `own budget would have ended it without saying why.`,
  });
  return delay;
}

function warnRetryRefused(
  handler: EventHandler | undefined,
  where: string,
  input: ConsultInput,
): void {
  handler?.({
    type: 'warning',
    nodeName: input.subject.nodeName ?? '',
    message:
      `${where} asked to retry, but "${input.subject.nodeName}" has ` +
      `already been attempted ${input.attempt} times and heddle allows ` +
      `${input.maxAttempts} (maxNodeAttempts). The retry is refused and ` +
      `the rest of the chain still gets its say.`,
  });
}

function unclaimedConfigMessage(
  componentType: string,
  provided: string[],
): string {
  const loaded =
    provided.length > 0
      ? `Middleware loaded: ${provided.join(', ')}.`
      : `No middleware is loaded at all — a middleware is host-configured, so it ` +
        `has to be loaded as well as configured.`;

  return (
    `configuration was supplied for "${componentType}", which no loaded plugin ` +
    `provides as a middleware. ${loaded} Only a middleware takes configuration ` +
    `this way; a node or a transform reads its fields from the document that ` +
    `names it.`
  );
}
