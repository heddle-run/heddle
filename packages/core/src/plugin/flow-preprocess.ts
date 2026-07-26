/**
 * Makes custom component types survive the agentspec SDK's closed zod unions.
 *
 * The SDK validates `Flow.nodes` against a discriminated union of the builtin node
 * types (NodeUnion), and `Agent.transforms` against one of the builtin transforms
 * (MessageTransformUnion). Neither union can be extended through the public API —
 * `registerNodeUnionSchema` is not exported, and there is no base
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
 * If the SDK ever exports a way to extend those unions, this whole module
 * collapses into registering the plugin's schemas and deleting the swap.
 */
import type { PluginRegistry } from './registry.js';
import type { PluginComponent, PluginNode } from './types.js';
import { PluginError } from '../errors.js';

/**
 * The stand-in node type. InputMessageNode is used because its factory passes
 * through caller-supplied `inputs` and `outputs` untouched and imposes no other
 * structural requirements — it is the most inert builtin node available.
 */
const PLACEHOLDER_TYPE = 'InputMessageNode';

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
  pluginNodes: Map<string, PluginNode>;
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
 * Replaces every plugin-typed node in the document with a stand-in the SDK
 * accepts, returning the rewritten document plus the real nodes.
 *
 * Returns the original document untouched when the flow uses no plugin nodes, so
 * specs that do not use plugins take exactly the path they did before.
 */
export function substitutePluginNodes(
  doc: Record<string, unknown>,
  registry: PluginRegistry,
  load: ComponentLoader,
): Substitution {
  const pluginNodes = new Map<string, PluginNode>();
  const pluginTransforms = new Map<string, PluginComponent>();

  if (registry.isEmpty()) {
    return { doc, pluginNodes, pluginTransforms };
  }

  // Referenced components live beside the nodes that point at them, so they are
  // collected up front and re-attached to each standalone deserialization.
  const referenced = collectReferencedComponents(doc);
  const idsByKey = new Map<string, string>();
  let substituted = false;

  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(walk);
    }
    if (!isPlainObject(value)) {
      return value;
    }

    const componentType = componentTypeOf(value);
    if (componentType && registry.hasNodeType(componentType)) {
      substituted = true;
      return placeholderFor(value, componentType, {
        referenced,
        idsByKey,
        components: pluginNodes as Map<string, PluginComponent>,
        load,
        build: (id, name, node) => ({
          component_type: PLACEHOLDER_TYPE,
          id,
          name,
          inputs: propertySchemas((node as PluginNode).inputs),
          outputs: propertySchemas((node as PluginNode).outputs),
        }),
      });
    }
    if (componentType && registry.hasTransformType(componentType)) {
      substituted = true;
      return placeholderFor(value, componentType, {
        referenced,
        idsByKey,
        components: pluginTransforms,
        load,
        build: (id, name) => ({
          component_type: PLACEHOLDER_TRANSFORM_TYPE,
          id,
          name,
          llm: PLACEHOLDER_LLM,
        }),
      });
    }

    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = OPAQUE_KEYS.has(key) ? child : walk(child);
    }
    return out;
  };

  const rewritten = walk(doc) as Record<string, unknown>;
  return {
    doc: substituted ? rewritten : doc,
    pluginNodes,
    pluginTransforms,
  };
}

function placeholderFor(
  raw: Record<string, unknown>,
  componentType: string,
  ctx: {
    referenced: Record<string, unknown>;
    idsByKey: Map<string, string>;
    components: Map<string, PluginComponent>;
    load: ComponentLoader;
    build: (
      id: string,
      name: string,
      component: PluginComponent,
    ) => Record<string, unknown>;
  },
): Record<string, unknown> {
  const name = raw.name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new PluginError(
      `${componentType}: "name" is required and must be a non-empty string`,
    );
  }

  // Keyed by name so a node inlined in several places (the nodes list and an
  // edge, say) resolves to one identity, which the SDK's invariants require.
  const key = `${componentType}:${name}`;
  let id = ctx.idsByKey.get(key);
  if (!id) {
    id = typeof raw.id === 'string' && raw.id ? raw.id : crypto.randomUUID();
    ctx.idsByKey.set(key, id);
  }

  if (!ctx.components.has(id)) {
    const withRefs: Record<string, unknown> = { ...raw, id };
    if (Object.keys(ctx.referenced).length > 0) {
      withRefs.$referenced_components = ctx.referenced;
    }
    const component = ctx.load(withRefs) as unknown as PluginComponent;
    ctx.components.set(id, component);
  }

  return ctx.build(id, name, ctx.components.get(id)!);
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
