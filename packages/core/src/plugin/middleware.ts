/**
 * The middleware chain: what heddle consults when a seam produces an outcome.
 *
 * The mechanism is not new. `TransformChain` has been doing this since before
 * plugins ran out of process — entries in order, a verdict per entry, the first
 * refusal wins — and its `reject` genuinely changes control flow, which is why
 * the playground can demo a guardrail with no credential. What a transform
 * cannot do is see anything except the two points in an agent's turn where it
 * is spliced. **Adding taps to a proven mechanism is a smaller change than
 * inventing one**, so the verdict vocabulary here is deliberately the same
 * shape, and this chain is deliberately the same three lines of logic.
 *
 * The one seam wired today is `nodeError`, the catch clause in `runner.ts`.
 * Before it, every node error was fatal and heddle had no error-handling
 * extension point of any kind: a transient 429 from a tool ended the run, and
 * `grep -rn 'retry\|backoff' packages/core/src` found nothing.
 */
import { snakeToCamel } from 'agentspec';
import { PluginError } from '../errors.js';
import type { Dependencies } from '../node/types.js';
import type { EventHandler } from '../runner/events.js';
import { pluginReporter } from './executor.js';
import { readAfterVerdict, type AfterVerdict } from './protocol.js';
import type { PluginRegistry } from './registry.js';
import { PluginModel, toolRunner } from './services.js';
import { readSubscription, type Seam } from './seams.js';
import type {
  MiddlewareContext,
  MiddlewareSubject,
  PluginMiddlewareExecutor,
  SeamOutcome,
} from './types.js';

/**
 * A middleware that failed, distinguished from anything a node did.
 *
 * A separate class because the two are never the same problem and the operator
 * who has to act on them is not always the same person. A node error belongs to
 * the flow; this belongs to whoever installed the middleware, and it must never
 * read as the flow being flaky.
 */
export class MiddlewareError extends PluginError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MiddlewareError';
  }
}

interface Entry {
  plugin: string;
  componentType: string;
  /**
   * The seams whose `after` half this entry hooks — not the seams it named.
   *
   * Keyed on the half as well as the seam because the two are declared
   * separately and mean different things. A component subscribing to
   * `nodeError: ['before']` is refused by `readSubscription`, but keying on the
   * seam alone would still have called the `after` of anything that got past —
   * a chain that ignores half the subscription is a chain whose declaration is
   * decoration.
   */
  after: Set<Seam>;
  impl: PluginMiddlewareExecutor;
  config: Record<string, unknown>;
  /**
   * The model this middleware may call, if its configuration names one.
   *
   * Built per entry and held across consults, so a fallback policy that asks a
   * model for a canned apology reuses one provider instead of one per failing
   * node. Which model is the **operator's** choice here rather than the spec's,
   * and that is the only sound answer: a middleware is installed by the
   * operator, runs on flows that never mention it, and is paid for by them —
   * so its `llm_config` lives in the configuration they supplied.
   */
  model: PluginModel;
  runTool: ReturnType<typeof toolRunner>;
}

/** Where a consult ends up, once the chain has spoken. */
export type ChainVerdict =
  | { action: 'pass' }
  | { action: 'replace'; value: Record<string, unknown>; by: string }
  | { action: 'retry'; delayMs: number; by: string }
  | { action: 'fail'; reason: string; by: string };

/**
 * The longest a middleware may make heddle wait between attempts.
 *
 * A delay is the one number in a verdict that costs wall-clock without doing
 * anything, and a middleware asking for an hour is either wrong or hostile —
 * neither is worth honouring, and the run's own timeout would kill it anyway
 * without saying why. Clamped rather than refused, because a retry policy that
 * over-reaches on backoff is still a retry policy worth running; the operator
 * is told with a warning naming both numbers.
 */
export const MAX_RETRY_DELAY = 30_000;

/** The chain for one run, built once at compile time. */
export class MiddlewareChain {
  private constructor(private readonly entries: Entry[]) {}

  /** An empty chain — the default, and free to consult. */
  static empty(): MiddlewareChain {
    return new MiddlewareChain([]);
  }

  /**
   * Build the chain from the registry's middleware, in load order.
   *
   * At compile time, like `TransformChain.build`, so a middleware that cannot
   * be constructed fails before the flow starts rather than on the first node
   * that happens to throw — which is a failure path, and the worst possible
   * place to discover a second one.
   *
   * **This is the only channel an operator's configuration travels on**, and it
   * is where that configuration is checked. There was briefly a second — a
   * `componentConfig` on the loader's options, validated against the manifest
   * and then dropped — and having two was worse than having the wrong one: the
   * validated channel delivered nothing and the delivering channel validated
   * nothing, and each was tested on its own, so both looked correct. Only this
   * function sees every middleware from every plugin at once, which is also the
   * only vantage point from which "a config nobody claims" can be spotted at
   * all.
   */
  static build(
    registry: PluginRegistry | undefined,
    deps: Dependencies,
    config: Record<string, Record<string, unknown>> = {},
  ): MiddlewareChain {
    const defs = registry?.middlewareDefs() ?? [];
    if (defs.length === 0) {
      // Refused rather than ignored even here, and especially here: an operator
      // who passed --plugin-config without the --plugin that provides it has
      // configured nothing, and silence would let them believe otherwise.
      checkUnclaimed(config, []);
      return MiddlewareChain.empty();
    }

    const entries = defs.map(({ plugin, def }): Entry => {
      const where = `middleware "${def.componentType}" (plugin "${plugin}")`;
      // `hasOwn`, not `config[type] ?? {}`. A component type is a plugin's own
      // string and `constructor`, `toString` and `valueOf` all match the name
      // pattern a manifest is checked against, so a plain-object lookup would
      // hand an unconfigured middleware something off `Object.prototype`
      // instead of the `{}` its contract promises. `PluginRegistry.claim`
      // happens to refuse all of those already — `isBuiltinComponentType`
      // answers true for anything on the prototype — so this is the second
      // lock, not the first. It is here because the first one is somebody
      // else's function and guards this by accident rather than on purpose.
      const own = normalize(
        Object.hasOwn(config, def.componentType) ? config[def.componentType] : {},
      );

      // Both checked before anything is constructed from either, so a bad
      // subscription and a bad configuration are compile-time failures with the
      // component named — not a middleware that loads and is never consulted.
      const seams = readSubscription(where, def.seams);
      def.validateConfig?.(own);

      return {
        plugin,
        componentType: def.componentType,
        after: new Set(
          (Object.keys(seams) as Seam[]).filter((seam) => seams[seam]?.includes('after')),
        ),
        impl: def.createMiddleware(own, deps),
        config: own,
        model: new PluginModel(where, own, deps),
        // Scopeless, and there is no scoped alternative to prefer: a
        // middleware is not a node and opens no tool scope, so each of its
        // tool calls gets a throwaway sandbox session — the same deal a
        // transform gets, for the same reason.
        runTool: toolRunner(where, deps),
      };
    });

    checkUnclaimed(
      config,
      defs.map(({ def }) => def.componentType),
    );

    return new MiddlewareChain(entries);
  }

  isEmpty(): boolean {
    return this.entries.length === 0;
  }

  /** Whether anything subscribes to the `after` half of this seam. */
  has(seam: Seam): boolean {
    return this.entries.some((entry) => entry.after.has(seam));
  }

  /** Every middleware installed, for the operator to see what is running. */
  describe(): string[] {
    return this.entries.map(
      (entry) => `${entry.componentType} (${entry.plugin}) on ${[...entry.after].join(', ')}`,
    );
  }

  /**
   * Consult the chain and return what it decided.
   *
   * **Reverse registration order**, which is the onion even without a
   * continuation: `before` would run outermost-first, so `after` runs
   * innermost-first and the middleware loaded first gets the last word. Nothing
   * subscribes to a `before` yet; the order is fixed now so that the day one
   * does, no middleware written today changes meaning.
   *
   * The first entry to answer anything but `pass` wins and the rest are not
   * consulted. That makes retry-versus-fail and retry-versus-retry conflicts
   * unreachable rather than ranked, so this design owes no ranking between them
   * — the same reason `TransformChain.apply` stops at the first rejection.
   *
   * **A middleware that fails is fatal**, and deliberately so. Every entry here
   * returns a verdict, and a verdict is authority; there is no observe-only
   * category to fail open for, because a component that only wants to watch has
   * `emitEvent` and `log`, which return nothing to anybody and cannot fail a
   * run. Skipping a broken one would mean a guardrail that silently stopped
   * guarding, reported by a warning nobody reads, on a component no flow
   * mentions — invisible by construction. It is also the rule every other kind
   * already runs under: a transform that throws fails the run, and so does a
   * plugin node.
   */
  async consult(
    seam: Seam,
    input: {
      subject: MiddlewareSubject;
      outcome: SeamOutcome;
      attempt: number;
      maxAttempts: number;
      /**
       * Whether a `retry` can still be honoured, which the caller knows and
       * this does not — the ceiling belongs to whatever owns the call site.
       *
       * When it is false a `retry` is not a win: it is treated as `pass` for
       * that entry alone and the chain keeps going. That distinction is the
       * whole of it. Returning `pass` for the *consult* would mean the first
       * middleware to ask for a retry it cannot have silences every middleware
       * behind it — so the natural two-plugin arrangement, a retry policy and a
       * fallback, loses the fallback at exactly the attempt it was installed
       * for. A refused retry is heddle's limit on one entry, not an answer on
       * behalf of the others.
       */
      allowRetry?: boolean;
    },
    signal: AbortSignal | undefined,
    handler: EventHandler | undefined,
  ): Promise<ChainVerdict> {
    let refused = false;

    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (!entry.after.has(seam)) continue;

      const where = `middleware "${entry.componentType}" (plugin "${entry.plugin}")`;
      const ctx = this.contextFor(entry, seam, input, signal, handler);

      // One try around both the call and the check, so every way a middleware
      // can be wrong arrives as one class. Split, they would not: a remote
      // middleware's bad verdict is read inside `remoteMiddlewareDef.after` and
      // would come back as a `MiddlewareError`, while an in-process one's is
      // read here — so the same mistake would carry two different names
      // depending on which side of a process boundary it was made on.
      //
      // The check runs on both paths even though the remote one has already
      // done it, because an in-process middleware's return value has been
      // through nothing at all. It is also what refuses a verdict the seam does
      // not admit — a `retry` at a call site that cannot re-issue anything.
      let checked: AfterVerdict;
      try {
        const verdict = await entry.impl.after(
          { subject: input.subject, outcome: input.outcome },
          ctx,
        );
        checked = readAfterVerdict(seam, verdict, where);
      } catch (err) {
        throw new MiddlewareError(
          `${where} failed while heddle was consulting it on ${seam}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }

      if (checked.action === 'pass') continue;

      switch (checked.action) {
        case 'replace':
          return { action: 'replace', value: checked.value, by: entry.componentType };
        case 'retry':
          if (input.allowRetry === false) {
            // Warned once, on the first entry that asks. Every later one is
            // asking about the same spent budget, and an operator does not need
            // the same sentence per middleware.
            if (!refused) {
              refused = true;
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
            continue;
          }
          return {
            action: 'retry',
            delayMs: clampDelay(checked.delayMs ?? 0, where, handler, input.subject),
            by: entry.componentType,
          };
        case 'fail':
          return { action: 'fail', reason: checked.reason, by: entry.componentType };
      }
    }

    return { action: 'pass' };
  }

  private contextFor(
    entry: Entry,
    seam: Seam,
    input: { subject: MiddlewareSubject; attempt: number; maxAttempts: number },
    signal: AbortSignal | undefined,
    handler: EventHandler | undefined,
  ): MiddlewareContext {
    // Filed under the node the seam is about, not under the middleware. A
    // middleware holds no position in the graph — the same problem a transform
    // has — and the failing node is the position a consumer can attribute this
    // to. Which middleware spoke is in `nodeType`, and in the event type itself.
    const reporter = pluginReporter(handler, {
      nodeName: input.subject.nodeName ?? entry.componentType,
      componentType: entry.componentType,
    });

    return {
      signal,
      seam,
      component: entry.config,
      attempt: input.attempt,
      maxAttempts: input.maxAttempts,
      runTool: entry.runTool,
      callModel: entry.model.bind(signal),
      ...reporter,
    };
  }
}

/**
 * Refuse configuration for a middleware nobody provides.
 *
 * One typed character is the whole failure mode: `--plugin-config RetryPolicee=…`
 * is accepted by every syntactic check there is, and then the middleware is
 * built with `{}` and does whatever its unconfigured branch does — while the
 * operator watches `--verbose` print the middleware's name and believes their
 * policy is in force. The same silence covers `--plugin-config` passed with no
 * `--plugin` at all, and configuration aimed at a node or a transform, which is
 * a real misunderstanding of which kinds read a document and which do not.
 */
function checkUnclaimed(
  config: Record<string, Record<string, unknown>>,
  provided: string[],
): void {
  const claimed = new Set(provided);
  for (const componentType of Object.keys(config)) {
    if (claimed.has(componentType)) continue;
    throw new PluginError(
      `configuration was supplied for "${componentType}", which no loaded plugin ` +
        `provides as a middleware. ` +
        `${
          provided.length > 0
            ? `Middleware loaded: ${provided.join(', ')}.`
            : `No middleware is loaded at all — a middleware is host-configured, so it ` +
              `has to be loaded as well as configured.`
        } Only a middleware takes configuration this way; a node or a transform ` +
        `reads its fields from the document that names it.`,
    );
  }
}

/**
 * The one key in an operator's configuration heddle reads itself.
 *
 * Everything else here belongs to the middleware author: their manifest schema
 * describes it, their handler reads it, and heddle passes it through untouched
 * — renaming an author's own fields would be heddle deciding what their config
 * looks like. `llm_config` is the exception because heddle is the one that
 * parses it, through the same `PluginModel` every other kind uses, and that
 * reads the camelCased spelling the SDK's deserializer produces.
 *
 * An operator's configuration never meets that deserializer — it arrives as
 * JSON on a command line. So without this, `llm_config` written exactly as the
 * error message in `PluginModel` instructs would be invisible, and the operator
 * would be told to add the thing they had just added.
 */
function normalize(config: Record<string, unknown>): Record<string, unknown> {
  const raw = config.llm_config;
  if (raw === undefined || config.llmConfig !== undefined) return config;
  return { ...config, llmConfig: camelize(raw) };
}

function camelize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelize);
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[snakeToCamel(key)] = camelize(nested);
  }
  return out;
}

function clampDelay(
  requested: number,
  where: string,
  handler: EventHandler | undefined,
  subject: MiddlewareSubject,
): number {
  const delay = Math.max(0, Math.min(requested, MAX_RETRY_DELAY));
  if (delay !== requested) {
    handler?.({
      type: 'warning',
      nodeName: subject.nodeName ?? '',
      message:
        `${where} asked to wait ${requested}ms before retrying; heddle waits ` +
        `${delay}ms. A delay is time the run spends doing nothing, and the run's ` +
        `own budget would have ended it without saying why.`,
    });
  }
  return delay;
}
