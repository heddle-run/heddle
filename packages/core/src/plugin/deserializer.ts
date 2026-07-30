import { propertyFromJsonSchema, snakeToCamel } from 'agentspec';
import type {
  ComponentDeserializationPlugin,
  DeserializationContext,
  Property,
} from 'agentspec';
import type {
  HeddlePlugin,
  PluginComponent,
  PluginComponentDef,
  PluginIO,
  PluginNode,
  PluginNodeDef,
} from './types.js';
import { PluginError } from '../errors.js';

type SerializedDict = Parameters<
  ComponentDeserializationPlugin['deserialize']
>[0];

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

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const OPAQUE_FIELDS = new Set(['metadata', 'config']);

const PROPERTY_ARRAY_FIELDS = new Set(['inputs', 'outputs']);

export function toProperty(io: PluginIO): Property {
  const schema: Record<string, unknown> = { title: io.title, type: io.type };
  if (io.description !== undefined) schema.description = io.description;
  if (io.default !== undefined) schema.default = io.default;
  return propertyFromJsonSchema(schema);
}

export class HeddleDeserializationPlugin
  implements ComponentDeserializationPlugin
{
  readonly pluginName: string;
  readonly pluginVersion: string;
  private readonly defs: Map<string, PluginComponentDef>;

  constructor(plugin: HeddlePlugin) {
    this.pluginName = plugin.name;
    this.pluginVersion = plugin.version;
    this.defs = indexDefs(plugin);
  }

  supportedComponentTypes(): string[] {
    return [...this.defs.keys()];
  }

  deserialize(
    data: SerializedDict,
    context: DeserializationContext,
  ): PluginComponent {
    const componentType = context.getComponentType(data);
    const def = this.defs.get(componentType);
    if (!def) {
      throw new PluginError(
        `plugin "${this.pluginName}" cannot deserialize component type "${componentType}"`,
      );
    }

    const fields = readFields(data, componentType, context);
    const component = assemble(fields, componentType);

    if (isNodeDef(def)) {
      applyNodeDefaults(component as PluginNode, def);
    }
    def.validate?.(component);

    return component;
  }
}

function indexDefs(plugin: HeddlePlugin): Map<string, PluginComponentDef> {
  const defs = new Map<string, PluginComponentDef>();

  const declared = [
    ...(plugin.components ?? []),
    ...(plugin.nodes ?? []),
    ...(plugin.transforms ?? []),
    ...(plugin.providers ?? []),
  ];

  for (const def of declared) {
    if (defs.has(def.componentType)) {
      throw new PluginError(
        `plugin "${plugin.name}" declares component type "${def.componentType}" twice`,
      );
    }
    defs.set(def.componentType, def);
  }

  return defs;
}

function readFields(
  data: SerializedDict,
  componentType: string,
  context: DeserializationContext,
): Record<string, unknown> {
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
      fields[key] = context.loadField(rawValue);
    }
  }

  return fields;
}

function assemble(
  fields: Record<string, unknown>,
  componentType: string,
): PluginComponent {
  const name = fields.name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new PluginError(
      `${componentType}: "name" is required and must be a non-empty string`,
    );
  }

  return {
    ...fields,
    id: typeof fields.id === 'string' ? fields.id : crypto.randomUUID(),
    name,
    componentType,
    metadata: isObject(fields.metadata) ? fields.metadata : {},
  } as PluginComponent;
}

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

    const record = entry as Record<string, unknown>;
    const schema = isObject(record.jsonSchema) ? record.jsonSchema : record;
    return propertyFromJsonSchema(schema);
  });
}

function isNodeDef(def: PluginComponentDef): def is PluginNodeDef {
  return typeof (def as PluginNodeDef).createExecutor === 'function';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}
