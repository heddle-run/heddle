import type {
  ManifestComponent,
  ManifestTool,
  PluginManifest,
} from './manifest.js';
import type { ToolDef } from '../tool/types.js';
import type { PluginHost } from './host.js';
import { toolRunner } from './services.js';
import { checkSchema } from './schema.js';
import { PluginError } from '../errors.js';
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
  PluginTransformDef,
  PluginTransformExecutor,
  TransformPhase,
  TransformResult,
  WireFrame,
} from './types.js';
import {
  readAfterVerdict,
  readChatChunk,
  readChatResponse,
  readToolResult,
  readWireFrames,
  type AfterVerdict,
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}
