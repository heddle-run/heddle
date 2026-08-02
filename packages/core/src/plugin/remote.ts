import type {
  ManifestComponent,
  ManifestTool,
  PluginManifest,
} from './manifest.js';
import type { ToolDef } from '../tool/types.js';
import type { PluginHost } from './host.js';
import { toolRunner } from './services.js';
import { checkSchema } from './schema.js';
import { PluginError, SessionConflictError } from '../errors.js';
import { isObject as isPlainObject, typeOf } from '../internal/util.js';
import type { SessionStore } from '../session/store.js';
import type {
  Checkpoint,
  SessionRecord,
  SessionSummary,
} from '../session/types.js';
import type {
  PluginComponent,
  PluginComponentDef,
  PluginEncoder,
  PluginEncoderDef,
  PluginMiddlewareDef,
  PluginMiddlewareExecutor,
  PluginNode,
  PluginNodeDef,
  PluginNodeExecutor,
  PluginProviderDef,
  PluginResult,
  PluginStoreDef,
  PluginTransformDef,
  PluginTransformExecutor,
  TransformPhase,
  TransformResult,
  WireFrame,
} from './types.js';
import {
  readAfterVerdict,
  readBeforeVerdict,
  readChatChunk,
  readChatResponse,
  readStoredList,
  readStoredRecord,
  readStoredVersion,
  readToolResult,
  readWireFrames,
  type AfterVerdict,
  type BeforeVerdict,
  type HostMethod,
} from './protocol.js';
import { serializeEvent } from './encoder.js';
import type { Event } from '../runner/events.js';
import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  Message,
  Provider,
} from '../llm/types.js';

const TRANSFORM_ACTIONS = new Set(['pass', 'modify', 'reject']);

export type { TransformPhase };

export function remoteNodeDef(
  manifest: PluginManifest,
  entry: ManifestComponent,
  host: () => PluginHost,
): PluginNodeDef {
  const def: PluginNodeDef = {
    componentType: entry.componentType,

    createExecutor(node: PluginNode, deps): PluginNodeExecutor {
      const where = nameOf(manifest.name, entry.componentType, node.name);
      const wire = serializable(node, `${entry.componentType} "${node.name}"`);
      host().setToolRunner(toolRunner(where, deps));

      return {
        async execute(input, ctx): Promise<PluginResult> {
          const raw = await host().call(
            'execute',
            {
              componentType: entry.componentType,
              node: wire,
              input,
              ...(host().confined
                ? { workspaceUnavailable: 'confined' as const }
                : { workspace: ctx.getWorkspace() }),
            },
            {
              signal: ctx.signal,
              reporter: ctx,
              runTool: ctx.runTool,
              callModel: ctx.callModel,
            },
          );
          return asResult(where, raw);
        },
      };
    },
  };

  applyManifestHooks(def, entry);

  const { inputs, outputs, branches } = entry;
  if (inputs) def.inferInputs = () => inputs;
  if (outputs) def.inferOutputs = () => outputs;
  if (branches) def.branches = () => branches;

  return def;
}

export function remoteTransformDef(
  manifest: PluginManifest,
  entry: ManifestComponent,
  host: () => PluginHost,
): PluginTransformDef {
  const def: PluginTransformDef = {
    componentType: entry.componentType,

    phase: () => entry.phase ?? 'pre',

    createTransform(
      component: PluginComponent,
      deps,
    ): PluginTransformExecutor {
      const where = nameOf(manifest.name, entry.componentType, component.name);
      const wire = serializable(
        component,
        `${entry.componentType} "${component.name}"`,
      );
      host().setToolRunner(toolRunner(where, deps));

      return {
        async apply(messages: Message[], ctx): Promise<TransformResult> {
          const raw = await host().call(
            'apply',
            {
              componentType: entry.componentType,
              component: wire,
              phase: ctx.phase,
              messages,
            },
            {
              signal: ctx.signal,
              reporter: ctx,
              runTool: ctx.runTool,
              callModel: ctx.callModel,
            },
          );
          return asTransformResult(
            `plugin "${manifest.name}": ${entry.componentType}`,
            raw,
          );
        },
      };
    },
  };

  applyManifestHooks(def, entry);
  return def;
}

export function remoteMiddlewareDef(
  manifest: PluginManifest,
  entry: ManifestComponent,
  host: () => PluginHost,
): PluginMiddlewareDef {
  const where = `middleware "${entry.componentType}" (plugin "${manifest.name}")`;

  return {
    componentType: entry.componentType,
    seams: entry.seams ?? {},

    validateConfig(config): void {
      if (!entry.schema) return;
      checkSchema(
        config,
        entry.schema,
        `plugin "${manifest.name}": configuration for "${entry.componentType}"`,
      );
    },

    createMiddleware(config, deps): PluginMiddlewareExecutor {
      const wire = serializable(config, `${entry.componentType} configuration`);
      host().setToolRunner(
        toolRunner(
          `plugin "${manifest.name}": middleware "${entry.componentType}"`,
          deps,
        ),
      );

      return {
        async before({ subject, input }, ctx): Promise<BeforeVerdict> {
          const raw = await host().call(
            'before',
            {
              seam: ctx.seam,
              componentType: entry.componentType,
              component: wire,
              subject,
              input,
              ...(ctx.answered ? { answered: ctx.answered } : {}),
            },
            {
              signal: ctx.signal,
              reporter: ctx,
              runTool: ctx.runTool,
              callModel: ctx.callModel,
            },
          );
          return readBeforeVerdict(ctx.seam, raw, where);
        },

        async after({ subject, outcome }, ctx): Promise<AfterVerdict> {
          const raw = await host().call(
            'after',
            {
              seam: ctx.seam,
              componentType: entry.componentType,
              component: wire,
              subject,
              outcome,
              attempt: ctx.attempt,
              maxAttempts: ctx.maxAttempts,
            },
            {
              signal: ctx.signal,
              reporter: ctx,
              runTool: ctx.runTool,
              callModel: ctx.callModel,
            },
          );
          return readAfterVerdict(ctx.seam, raw, where);
        },
      };
    },
  };
}

export function remoteProviderDef(
  manifest: PluginManifest,
  entry: ManifestComponent,
  host: () => PluginHost,
): PluginProviderDef {
  const def: PluginProviderDef = {
    componentType: entry.componentType,

    createProvider(component: PluginComponent, deps): Provider {
      const where = nameOf(manifest.name, entry.componentType, component.name);
      const config = serializable(
        component,
        `${entry.componentType} "${component.name}"`,
      );
      const runTool = toolRunner(where, deps);

      const provider: Provider = {
        async chatCompletion(
          signal,
          request: ChatRequest,
        ): Promise<ChatResponse> {
          const raw = await host().call(
            'chat',
            {
              componentType: entry.componentType,
              config,
              request,
              stream: false,
            },
            { signal, runTool },
          );
          return readChatResponse(raw, where);
        },
      };

      if (entry.stream) {
        provider.chatCompletionStream = (
          signal,
          request,
        ): AsyncIterable<ChatChunk> =>
          pullFrom(
            (onPartial) =>
              host().call(
                'chat',
                {
                  componentType: entry.componentType,
                  config,
                  request,
                  stream: true,
                },
                { signal, onPartial, runTool },
              ),
            where,
          );
      }

      return provider;
    },
  };

  applyManifestHooks(def, entry);
  return def;
}

export function remoteEncoderDef(
  manifest: PluginManifest,
  entry: ManifestComponent,
  host: () => PluginHost,
): PluginEncoderDef {
  const componentType = entry.componentType;
  const protocol = entry.protocol as string;
  const where = nameOf(manifest.name, componentType, protocol);

  return {
    componentType,
    protocol,
    contentType: entry.contentType as string,

    createEncoder(runId: string): PluginEncoder {
      return {
        async encode(event: Event): Promise<WireFrame[]> {
          const raw = await host().call('encode', {
            componentType,
            runId,
            event: serializeEvent(event),
          });
          return readWireFrames(raw, `${where} rendering a "${event.type}"`);
        },

        async finish(): Promise<WireFrame[]> {
          const raw = await host().call('finishEncode', {
            componentType,
            runId,
          });
          return readWireFrames(raw, `${where} finishing the run`);
        },
      };
    },
  };
}

/**
 * A store that lives in another process.
 *
 * Every method is one round trip, and the store is consulted at least twice per
 * turn — so the budget that matters here is `pluginCallTimeout`, not the run's.
 * A `SessionConflictError` is reconstructed from the plugin's answer rather
 * than from its error, because a conflict is a *result* a store reports and not
 * a failure: the caller re-reads and decides, which it can only do if the error
 * survived the process boundary as itself.
 */
export function remoteStoreDef(
  manifest: PluginManifest,
  entry: ManifestComponent,
  host: () => PluginHost,
): PluginStoreDef {
  const componentType = entry.componentType;
  const where = `store "${componentType}" (plugin "${manifest.name}")`;

  return {
    componentType,

    createStore(config): SessionStore {
      if (entry.schema) {
        checkSchema(
          config,
          entry.schema,
          `plugin "${manifest.name}": configuration for "${componentType}"`,
        );
      }
      const settings = serializable(
        config,
        `${componentType} configuration`,
      );

      const call = (
        method: HostMethod,
        params: Record<string, unknown>,
      ): Promise<unknown> =>
        host().call(method, { componentType, config: settings, ...params });

      return {
        async create(id, init = {}) {
          await call('sessionCreate', { id, flow: init.flow });
        },

        async read(id) {
          return readStoredRecord<SessionRecord>(
            await call('sessionRead', { id }),
            `${where} reading "${id}"`,
            'a session record',
          );
        },

        async append(id, turn, expect) {
          const raw = await call('sessionAppend', {
            id,
            turn: turn as unknown as Record<string, unknown>,
            expect,
          });
          assertNoConflict(raw, id, expect, where);
          return readStoredVersion(raw, `${where} appending to "${id}"`);
        },

        async readCheckpoint(id) {
          return readStoredRecord<Checkpoint>(
            await call('sessionCheckpointRead', { id }),
            `${where} reading the checkpoint of "${id}"`,
            'a checkpoint',
          );
        },

        async writeCheckpoint(id, checkpoint) {
          await call('sessionCheckpointWrite', {
            id,
            checkpoint: checkpoint as Record<string, unknown> | null,
          });
        },

        async list(options = {}) {
          return readStoredList<SessionSummary>(
            await call('sessionList', {
              limit: options.limit,
              cursor: options.cursor,
            }),
            `${where} listing sessions`,
          );
        },

        async delete(id) {
          await call('sessionDelete', { id });
        },
      };
    },
  };
}

/**
 * Turn a store's reported conflict back into the error the caller catches.
 *
 * A store in another process cannot throw across the boundary, so it answers
 * `{ conflict: { version } }` instead. Without this the caller would see a
 * malformed result rather than the one failure it is written to handle.
 */
function assertNoConflict(
  raw: unknown,
  id: string,
  expect: number,
  where: string,
): void {
  if (!isPlainObject(raw)) return;

  const conflict = raw.conflict;
  if (conflict === undefined) return;

  const actual = isPlainObject(conflict) ? conflict.version : undefined;
  if (typeof actual !== 'number') {
    throw new PluginError(
      `${where} reported a conflict on "${id}" with no numeric ` +
        `"conflict.version". The caller re-reads at the version the store ` +
        `actually holds, so a conflict without one cannot be acted on.`,
    );
  }

  throw new SessionConflictError(id, expect, actual);
}

export function remoteComponentDef(
  entry: ManifestComponent,
): PluginComponentDef {
  const def: PluginComponentDef = { componentType: entry.componentType };
  applyManifestHooks(def, entry);
  return def;
}

export function remoteToolDef(
  manifest: PluginManifest,
  tool: ManifestTool,
  host: () => PluginHost,
): ToolDef {
  const where = `plugin "${manifest.name}": tool "${tool.name}"`;

  return {
    name: tool.name,
    description: tool.description ?? '',
    origin: `plugin:${manifest.name}`,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    shadows: tool.shadows,
    impl: {
      kind: 'plugin',
      plugin: manifest.name,
      call: async (signal, input) => {
        const raw = await host().call(
          'callTool',
          {
            componentType: tool.componentType as string,
            tool: tool.name,
            input,
          },
          { signal },
        );
        return readToolResult(raw, where);
      },
    },
  };
}

async function* pullFrom(
  start: (onPartial: (partial: unknown) => void) => Promise<unknown>,
  where: string,
): AsyncGenerator<ChatChunk> {
  const queue: ChatChunk[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  let failed = false;
  let failure: unknown;

  const nudge = (): void => {
    wake?.();
    wake = undefined;
  };

  const fail = (err: unknown): void => {
    failed = true;
    failure = err;
  };

  const call = start((partial) => {
    queue.push(readChatChunk(partial, where));
    nudge();
  }).then(
    (result) => {
      try {
        if (result !== undefined && result !== null) {
          queue.push(readChatChunk(result, where));
        }
      } catch (err) {
        fail(err);
      }
      done = true;
      nudge();
    },
    (err: unknown) => {
      fail(err);
      done = true;
      nudge();
    },
  );

  try {
    for (;;) {
      while (queue.length > 0) yield queue.shift() as ChatChunk;
      if (failed) throw failure;
      if (done) return;

      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    void call.catch(() => {});
  }
}

function applyManifestHooks(
  def: PluginComponentDef,
  entry: ManifestComponent,
): void {
  if (!entry.schema) return;
  def.validate = (component) =>
    checkSchema(
      component,
      entry.schema as Record<string, unknown>,
      `${entry.componentType} "${component.name}"`,
    );
}

function serializable(value: unknown, what: string): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch (err) {
    throw new PluginError(
      `${what} cannot be serialized for an out-of-process plugin`,
      { cause: err },
    );
  }
}

function asResult(where: string, raw: unknown): PluginResult {
  if (!isPlainObject(raw)) {
    throw new PluginError(
      `${where} returned ${typeOf(raw)}, expected { output, branch? }`,
    );
  }
  if (!isPlainObject(raw.output)) {
    throw new PluginError(`${where} returned no "output" object`);
  }
  if (raw.branch !== undefined && typeof raw.branch !== 'string') {
    throw new PluginError(`${where} returned a non-string "branch"`);
  }

  return { output: raw.output, branch: raw.branch };
}

function asTransformResult(where: string, raw: unknown): TransformResult {
  if (!isPlainObject(raw)) {
    throw new PluginError(
      `${where} returned ${typeOf(raw)}, expected { action, ... }`,
    );
  }
  if (
    typeof raw.action !== 'string' ||
    !TRANSFORM_ACTIONS.has(raw.action)
  ) {
    throw new PluginError(
      `${where} returned action ${JSON.stringify(raw.action)}; expected pass, modify or reject`,
    );
  }
  if (raw.action === 'modify' && !Array.isArray(raw.messages)) {
    throw new PluginError(`${where} returned action "modify" without "messages"`);
  }

  return {
    action: raw.action as TransformResult['action'],
    messages: raw.messages as Message[] | undefined,
    reason: typeof raw.reason === 'string' ? raw.reason : undefined,
  };
}

function nameOf(
  plugin: string,
  componentType: string,
  componentName: string,
): string {
  return `plugin "${plugin}": ${componentType} "${componentName}"`;
}

