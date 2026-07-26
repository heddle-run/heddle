/**
 * Bridges heddle plugin declarations to the agentspec SDK's deserialization
 * plugin interface.
 *
 * The SDK already knows how to dispatch an unknown `component_type` to a plugin
 * (see AgentSpecDeserializer). What it cannot do is invent the shape of that
 * component, so this module turns each PluginComponentDef into the
 * ComponentDeserializationPlugin the SDK expects.
 */
import { propertyFromJsonSchema, snakeToCamel } from 'agentspec';
import type {
  ComponentDeserializationPlugin,
  DeserializationContext,
  Property,
} from 'agentspec';

/** The SDK's serialized-dict type, which it does not re-export by name. */
type SerializedDict = Parameters<
  ComponentDeserializationPlugin['deserialize']
>[0];
import type {
  HeddlePlugin,
  PluginComponent,
  PluginComponentDef,
  PluginIO,
  PluginNode,
  PluginNodeDef,
} from './types.js';
import { PluginError } from '../errors.js';

/**
 * Protocol fields the SDK owns. They carry the envelope, not the component's
 * own data, so they never become fields on the deserialized component.
 */
const PROTOCOL_FIELDS = new Set([
  'component_type',
  'componentType',
  'agentspec_version',
  'agentspecVersion',
  'component_plugin_name',
  'componentPluginName',
  'component_plugin_version',
  'componentPluginVersion',
  'air_version',
  '$referenced_components',
  '$component_ref',
]);

/** Keys rejected to prevent prototype pollution. */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Fields holding user data rather than nested components. They are copied
 * verbatim instead of being walked for `$component_ref` resolution.
 */
const OPAQUE_FIELDS = new Set(['metadata', 'config']);

/** Fields holding Property arrays, deserialized from json schema dicts. */
const PROPERTY_ARRAY_FIELDS = new Set(['inputs', 'outputs']);

/** Converts a plugin's lightweight IO declaration into an SDK Property. */
export function toProperty(io: PluginIO): Property {
  const schema: Record<string, unknown> = { title: io.title, type: io.type };
  if (io.description !== undefined) schema.description = io.description;
  if (io.default !== undefined) schema.default = io.default;
  return propertyFromJsonSchema(schema);
}

function isNodeDef(def: PluginComponentDef): def is PluginNodeDef {
  return typeof (def as PluginNodeDef).createExecutor === 'function';
}

/**
 * A deserialization plugin backed by one heddle plugin's component declarations.
 *
 * `pluginName` / `pluginVersion` are what the SDK writes into
 * `component_plugin_name` and `component_plugin_version` on export, so a spec
 * produced by heddle round-trips through other Agent Spec tooling.
 */
export class HeddleDeserializationPlugin
  implements ComponentDeserializationPlugin
{
  readonly pluginName: string;
  readonly pluginVersion: string;
  private defs: Map<string, PluginComponentDef>;

  constructor(plugin: HeddlePlugin) {
    this.pluginName = plugin.name;
    this.pluginVersion = plugin.version;
    this.defs = new Map();
    for (const def of [
      ...(plugin.components ?? []),
      ...(plugin.nodes ?? []),
      ...(plugin.transforms ?? []),
    ]) {
      if (this.defs.has(def.componentType)) {
        throw new PluginError(
          `plugin "${plugin.name}" declares component type "${def.componentType}" twice`,
        );
      }
      this.defs.set(def.componentType, def);
    }
  }

  supportedComponentTypes(): string[] {
    return [...this.defs.keys()];
  }

  deserialize(
    data: SerializedDict,
    context: DeserializationContext,
  ): PluginComponent {
    // The context knows which naming convention this document uses.
    const componentType = context.getComponentType(data);
    const def = this.defs.get(componentType);
    if (!def) {
      throw new PluginError(
        `plugin "${this.pluginName}" cannot deserialize component type "${componentType}"`,
      );
    }

    const fields: Record<string, unknown> = {};
    for (const [rawKey, rawValue] of Object.entries(data)) {
      if (PROTOCOL_FIELDS.has(rawKey) || DANGEROUS_KEYS.has(rawKey)) continue;
      const key = snakeToCamel(rawKey);
      if (DANGEROUS_KEYS.has(key)) continue;

      if (PROPERTY_ARRAY_FIELDS.has(key)) {
        fields[key] = toPropertyArray(key, rawValue, componentType);
      } else if (OPAQUE_FIELDS.has(key)) {
        fields[key] = rawValue;
      } else {
        // Resolves nested components and $component_ref pointers, so a custom
        // component can hold other custom (or builtin) components.
        fields[key] = context.loadField(rawValue);
      }
    }

    const name = fields.name;
    if (typeof name !== 'string' || name.length === 0) {
      throw new PluginError(
        `${componentType}: "name" is required and must be a non-empty string`,
      );
    }

    const component = {
      ...fields,
      id: typeof fields.id === 'string' ? fields.id : crypto.randomUUID(),
      name,
      componentType,
      metadata:
        fields.metadata && typeof fields.metadata === 'object'
          ? (fields.metadata as Record<string, unknown>)
          : {},
    } as PluginComponent;

    if (isNodeDef(def)) {
      applyNodeDefaults(component as PluginNode, def);
    }

    def.validate?.(component);
    return component;
  }
}

/** Fills in inputs, outputs and branches the spec file left unspecified. */
function applyNodeDefaults(node: PluginNode, def: PluginNodeDef): void {
  if (node.inputs === undefined && def.inferInputs) {
    node.inputs = def.inferInputs(node).map(toProperty);
  }
  if (node.outputs === undefined && def.inferOutputs) {
    node.outputs = def.inferOutputs(node).map(toProperty);
  }
  if (node.branches === undefined && def.branches) {
    node.branches = def.branches(node);
  }
  node.inputs ??= [];
  node.outputs ??= [];
  node.branches ??= [];
}

function toPropertyArray(
  field: string,
  value: unknown,
  componentType: string,
): Property[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new PluginError(
      `${componentType}: "${field}" must be an array of json schemas`,
    );
  }
  return value.map((entry) => {
    if (entry === null || typeof entry !== 'object') {
      throw new PluginError(
        `${componentType}: "${field}" entries must be json schema objects`,
      );
    }
    // Already-deserialized Property objects carry their schema on `jsonSchema`.
    const record = entry as Record<string, unknown>;
    const schema =
      record.jsonSchema && typeof record.jsonSchema === 'object'
        ? (record.jsonSchema as Record<string, unknown>)
        : record;
    return propertyFromJsonSchema(schema);
  });
}
