import { snakeToCamel } from 'agentspec';
import { PluginError } from '../errors.js';
import type { Dependencies } from '../node/types.js';
import type { EventHandler } from '../runner/events.js';
import { pluginReporter } from './executor.js';
import { readAfterVerdict, type AfterVerdict } from './protocol.js';
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
