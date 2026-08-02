import { z } from 'zod';
import { isObject as isPlainObject } from '../internal/util.js';
import {
  isBuiltinComponentType,
  LlmConfigUnion,
  MessageTransformUnion,
  NodeUnion,
  registerLlmConfigSchema,
  registerMessageTransformSchema,
  registerNodeUnionSchema,
} from 'agentspec';

interface PluginComponent extends Record<string, unknown> {
  componentType: string;
}

let installed = false;

export function installWidenedUnions(): void {
  if (installed) return;
  installed = true;

  registerNodeUnionSchema(widen(NodeUnion, 'node'));
  registerMessageTransformSchema(widen(MessageTransformUnion, 'transform'));
  registerLlmConfigSchema(widen(LlmConfigUnion, 'llm config'));
}

function widen(
  builtinUnion: z.ZodTypeAny,
  slot: string,
): z.ZodType<Record<string, unknown>> {
  return z.any().transform((value: unknown, ctx: z.RefinementCtx) => {
    const component = asPluginComponent(value);
    if (!component) return parseAsBuiltin(builtinUnion, value, ctx);

    if (!hasIdentity(component)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: missingIdentityMessage(slot, component.componentType),
      });
      return z.NEVER;
    }

    return component;
  }) as unknown as z.ZodType<Record<string, unknown>>;
}

function asPluginComponent(value: unknown): PluginComponent | undefined {
  if (!isPlainObject(value)) return undefined;

  const componentType = value.componentType;
  if (typeof componentType !== 'string') return undefined;
  if (isBuiltinComponentType(componentType)) return undefined;

  return value as PluginComponent;
}

function hasIdentity(component: PluginComponent): boolean {
  return (
    typeof component.id === 'string' &&
    component.id.length > 0 &&
    typeof component.name === 'string'
  );
}

function parseAsBuiltin(
  builtinUnion: z.ZodTypeAny,
  value: unknown,
  ctx: z.RefinementCtx,
): Record<string, unknown> {
  const parsed = builtinUnion.safeParse(value);
  if (parsed.success) return parsed.data as Record<string, unknown>;

  for (const issue of parsed.error.issues) ctx.addIssue(issue);
  return z.NEVER;
}

function missingIdentityMessage(slot: string, componentType: string): string {
  return (
    `${slot} of type "${componentType}" needs a non-empty "id" and a "name". ` +
    `heddle assigns both when it deserializes a plugin component, so seeing ` +
    `this means the component reached the SDK by another route.`
  );
}

