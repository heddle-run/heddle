/**
 * Reports the two things a document can say about a custom component that the
 * SDK cannot report well.
 *
 * This module used to do much more. Agent Spec validates `Flow.nodes` against a
 * closed union of builtin node types and `Agent.transforms` against one of the
 * two builtin transforms, so a flow carrying a custom component was rejected
 * before any plugin ran. The workaround was substitution: deserialize each
 * plugin component on its own, hand the SDK a stand-in carrying the same id and
 * name — an `InputMessageNode` with synthesized `inputs`/`outputs`, or a
 * `MessageSummarizationTransform` with a fabricated `OllamaConfig` pointing at
 * `localhost:11434` — and swap the real components back afterwards, keyed by id.
 *
 * `spec/open-unions.ts` widened both unions, so none of that is needed: the SDK
 * deserializes the real component in place, through the plugin path it always
 * had. What is left here is the part substitution was never the reason for.
 *
 * **Two refusals, both about the message rather than the outcome.** The SDK does
 * refuse both of these on its own, with `No plugin to deserialize component type
 * "X"`. That is true and it is useless: it names neither which plugins *are*
 * loaded, nor how to load another, nor — in the middleware case — that the
 * component type is real and the mistake is writing it into a document at all.
 * A walk that runs before the SDK sees the document is what buys those.
 */
import { isBuiltinComponentType } from 'agentspec';
import type { PluginRegistry } from './registry.js';
import { PluginError } from '../errors.js';

/** Fields holding user data, never walked looking for nested components. */
const OPAQUE_KEYS = new Set(['metadata', 'config', 'data', 'headers', 'queryParams']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `component_type` of a component dict, in either spelling. */
function componentTypeOf(value: Record<string, unknown>): string | undefined {
  const raw = value.component_type ?? value.componentType;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/**
 * Walk a document and refuse what heddle can explain better than the SDK.
 *
 * Rewrites nothing and returns nothing. That is the whole difference from what
 * this used to be, and it is worth stating: the document handed to the SDK is
 * now the document the author wrote, so a plugin component's identity, its
 * nested components and its `$component_ref` pointers are resolved once by one
 * `DeserializationContext` rather than reassembled from separate parses.
 */
export function checkPluginComponents(
  doc: Record<string, unknown>,
  registry: PluginRegistry,
): void {
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) walk(child);
      return;
    }
    if (!isPlainObject(value)) return;

    const componentType = componentTypeOf(value);
    if (componentType) {
      const kind = registry.kindOf(componentType);

      if (kind === 'middleware') {
        // Middleware is host-configured: the operator installs it and it runs
        // on every node, which is exactly why a document cannot ask for one.
        // Left to the SDK this reads as a component type nothing provides,
        // sending the author to load a plugin that is already loaded.
        throw new PluginError(
          `component "${value.name ?? '(unnamed)'}" has type "${componentType}", ` +
            `which is a middleware. Middleware is installed by whoever runs heddle ` +
            `and applies to every node in the flow, so it is not written into a ` +
            `spec — remove it here and load it with --plugin instead.`,
        );
      }

      if (!kind && !isBuiltinComponentType(componentType)) {
        throw new PluginError(
          `component "${value.name ?? '(unnamed)'}" has type "${componentType}", ` +
            `which is not a builtin and no loaded plugin provides.\n` +
            `  Loaded plugins: ${registry.describe()}\n` +
            `  If it comes from a plugin, load it with: --plugin <module>`,
        );
      }
    }

    for (const [key, child] of Object.entries(value)) {
      if (!OPAQUE_KEYS.has(key)) walk(child);
    }
  };

  walk(doc);
}
