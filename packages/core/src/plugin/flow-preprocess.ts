/**
 * Makes custom component types survive the agentspec SDK's closed zod unions.
 *
 * The SDK validates `Flow.nodes` against a discriminated union of the builtin node
 * types (NodeUnion), and `Agent.transforms` against one of the builtin transforms
 * (MessageTransformUnion). Neither union is extended in practice. The vendored SDK
 * now re-exports `registerNodeUnionSchema`, but nothing in heddle calls it, so
 * `NodeUnion` is still closed at the point a flow is parsed; and there is no base
 * `MessageTransformSchema` in the TypeScript SDK at all. So while the SDK's plugin
 * system can deserialize a custom component on its own, a flow or agent containing
 * one is rejected before any plugin runs.
 *
 * The workaround: deserialize each custom component separately (where the plugin
 * path does work), then hand the SDK a stand-in that carries the same id and name.
 * The SDK still checks every invariant it normally would — start/end node rules,
 * edge endpoints, data flow property matching — because all of those read fields
 * the stand-in preserves. heddle swaps the real components back in afterwards,
 * keyed by id, so a stand-in never reaches the runtime or a serialized file.
 *
 * The node half of the escape hatch exists — see the patch series in
 * vendor/agentspec/VENDOR.md. This module collapses into registering the plugin's
 * schemas and deleting the swap once something actually registers a widened
 * `NodeUnion`, and the transform half exists too. Until then it is load-bearing
 * for every plugin node, exported seam or not.
 */
import { isBuiltinComponentType } from 'agentspec';
import type { PluginRegistry } from './registry.js';
import type { PluginComponent } from './types.js';
import { PluginError } from '../errors.js';

/**
 * The stand-in node type. InputMessageNode is used because its factory passes
 * through caller-supplied `inputs` and `outputs` untouched and imposes no other
 * structural requirements — it is the most inert builtin node available.
 */
const PLACEHOLDER_NODE_TYPE = 'InputMessageNode';

/**
 * The stand-in transform type. Both builtin transforms require an `llm`, so one
 * is synthesized; it is never read, because the real transform is restored before
 * the agent runs.
 */
const PLACEHOLDER_TRANSFORM_TYPE = 'MessageSummarizationTransform';

const PLACEHOLDER_LLM = {
  component_type: 'OllamaConfig',
  name: 'heddle-placeholder-llm',
  url: 'http://localhost:11434',
  model_id: 'placeholder',
};

/** Fields holding user data, never walked looking for nested components. */
const OPAQUE_KEYS = new Set(['metadata', 'config', 'data', 'headers', 'queryParams']);

export interface Substitution {
  /** The document to hand to the SDK deserializer. */
  doc: Record<string, unknown>;
  /** Real plugin nodes, keyed by the id shared with their stand-in. */
  pluginNodes: Map<string, PluginComponent>;
  /** Real plugin transforms, keyed by the id shared with their stand-in. */
  pluginTransforms: Map<string, PluginComponent>;
}

/** Deserializes one custom component dict on its own, outside a Flow envelope. */
export type ComponentLoader = (
  dict: Record<string, unknown>,
) => Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function componentTypeOf(value: Record<string, unknown>): string | undefined {
  const ct = value.component_type ?? value.componentType;
  return typeof ct === 'string' ? ct : undefined;
}

/**
 * Replaces every plugin-provided component in the document with a stand-in the
 * SDK accepts, returning the rewritten document plus the real components.
 *
 * This walk visits every component in the document, so it is also where an
 * unrecognised `component_type` is caught: doing it here names the offending
 * component, which the SDK's own error cannot.
 */
export function substitutePluginNodes(
  doc: Record<string, unknown>,
  registry: PluginRegistry,
  load: ComponentLoader,
): Substitution {
  const pluginNodes = new Map<string, PluginComponent>();
  const pluginTransforms = new Map<string, PluginComponent>();

  // Referenced components live beside the components that point at them, so they
  // are collected up front and re-attached to each standalone deserialization.
  const referenced = collectReferencedComponents(doc);
  const idsByKey = new Map<string, string>();

  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(walk);
    }
    if (!isPlainObject(value)) {
      return value;
    }

    const componentType = componentTypeOf(value);
    if (componentType) {
      const kind = registry.kindOf(componentType);

      if (kind === 'node') {
        const component = resolve(value, componentType, pluginNodes);
        return {
          component_type: PLACEHOLDER_NODE_TYPE,
          id: component.id,
          name: component.name,
          inputs: propertySchemas(component.inputs),
          outputs: propertySchemas(component.outputs),
        };
      }

      if (kind === 'transform') {
        const component = resolve(value, componentType, pluginTransforms);
        return {
          component_type: PLACEHOLDER_TRANSFORM_TYPE,
          id: component.id,
          name: component.name,
          llm: PLACEHOLDER_LLM,
        };
      }

      // `component` kinds are nested inside a plugin node or transform and are
      // deserialized with their parent, so they need no stand-in of their own.
      if (!kind && !isBuiltinComponentType(componentType)) {
        throw new PluginError(
          `component "${value.name ?? '(unnamed)'}" has type "${componentType}", ` +
            `which is not a builtin and no loaded plugin provides.\n` +
            `  Loaded plugins: ${registry.describe()}\n` +
            `  If it comes from a plugin, load it with: --plugin <module>`,
        );
      }
    }

    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = OPAQUE_KEYS.has(key) ? child : walk(child);
    }
    return out;
  };

  /**
   * Deserializes one plugin component and remembers it under a stable id, so the
   * stand-in and the real component agree on identity.
   */
  const resolve = (
    raw: Record<string, unknown>,
    componentType: string,
    into: Map<string, PluginComponent>,
  ): PluginComponent => {
    const name = raw.name;
    if (typeof name !== 'string' || name.length === 0) {
      throw new PluginError(
        `${componentType}: "name" is required and must be a non-empty string`,
      );
    }

    // Keyed by name so a component inlined in several places (the nodes list and
    // an edge, say) resolves to one identity, which the SDK's invariants require.
    const key = `${componentType}:${name}`;
    let id = idsByKey.get(key);
    if (!id) {
      id = typeof raw.id === 'string' && raw.id ? raw.id : crypto.randomUUID();
      idsByKey.set(key, id);
    }

    let component = into.get(id);
    if (!component) {
      const withRefs: Record<string, unknown> = { ...raw, id };
      if (Object.keys(referenced).length > 0) {
        withRefs.$referenced_components = referenced;
      }
      component = load(withRefs) as unknown as PluginComponent;
      into.set(id, component);
    }
    return component;
  };

  return {
    doc: walk(doc) as Record<string, unknown>,
    pluginNodes,
    pluginTransforms,
  };
}

/** Unwraps Property objects back to the json schema dicts the SDK reparses. */
function propertySchemas(properties: unknown): unknown[] {
  if (!Array.isArray(properties)) return [];
  return properties.map((p) => {
    const record = p as Record<string, unknown>;
    return isPlainObject(record?.jsonSchema) ? record.jsonSchema : record;
  });
}

/** Gathers every `$referenced_components` map in the document into one object. */
function collectReferencedComponents(
  doc: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isPlainObject(value)) return;

    const refs = value.$referenced_components;
    if (isPlainObject(refs)) {
      for (const [id, component] of Object.entries(refs)) {
        out[id] = component;
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === '$referenced_components' || OPAQUE_KEYS.has(key)) continue;
      visit(child);
    }
  };

  visit(doc);
  return out;
}
