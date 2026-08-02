import { isBuiltinComponentType } from 'agentspec';
import type { PluginRegistry } from './registry.js';
import { PluginError } from '../errors.js';
import { isObject as isPlainObject } from '../internal/util.js';

const OPAQUE_KEYS = new Set([
  'metadata',
  'config',
  'data',
  'headers',
  'queryParams',
]);

export function checkPluginComponents(
  doc: Record<string, unknown>,
  registry: PluginRegistry,
): void {
  walk(doc, registry);
}

function walk(value: unknown, registry: PluginRegistry): void {
  if (Array.isArray(value)) {
    for (const child of value) walk(child, registry);
    return;
  }
  if (!isPlainObject(value)) return;

  assertUsableInDocument(value, registry);

  for (const [key, child] of Object.entries(value)) {
    if (!OPAQUE_KEYS.has(key)) walk(child, registry);
  }
}

function assertUsableInDocument(
  component: Record<string, unknown>,
  registry: PluginRegistry,
): void {
  const componentType = componentTypeOf(component);
  if (!componentType) return;

  const name = String(component.name ?? '(unnamed)');
  const kind = registry.kindOf(componentType);

  if (kind === 'middleware') {
    throw new PluginError(middlewareInDocumentMessage(name, componentType));
  }
  if (kind === 'encoder') {
    throw new PluginError(encoderInDocumentMessage(name, componentType));
  }
  if (!kind && !isBuiltinComponentType(componentType)) {
    throw new PluginError(
      unknownComponentMessage(name, componentType, registry),
    );
  }
}

function componentTypeOf(
  component: Record<string, unknown>,
): string | undefined {
  const raw = component.component_type ?? component.componentType;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function middlewareInDocumentMessage(
  name: string,
  componentType: string,
): string {
  return (
    `component "${name}" has type "${componentType}", ` +
    `which is a middleware. Middleware is installed by whoever runs heddle ` +
    `and applies to every node in the flow, so it is not written into a ` +
    `spec — remove it here and load it with --plugin instead.`
  );
}

function encoderInDocumentMessage(name: string, componentType: string): string {
  return (
    `component "${name}" has type "${componentType}", ` +
    `which is an encoder. An encoder renders the run for a client rather ` +
    `than doing anything inside it, so it is chosen by the request that ` +
    `starts the run — remove it here and ask for its protocol instead.`
  );
}

function unknownComponentMessage(
  name: string,
  componentType: string,
  registry: PluginRegistry,
): string {
  return (
    `component "${name}" has type "${componentType}", ` +
    `which is not a builtin and no loaded plugin provides.\n` +
    `  Loaded plugins: ${registry.describe()}\n` +
    `  If it comes from a plugin, load it with: --plugin <module>`
  );
}
