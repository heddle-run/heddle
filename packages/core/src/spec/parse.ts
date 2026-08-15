/**
 * The structural pass: a parsed YAML/JSON value in, a {@link ParsedFlow} out.
 *
 * This pass knows the document alone — key by key, strictly. Unknown keys are
 * refused everywhere except `meta` and a `use:`/transform config, names are
 * checked against the shapes references can hold, and every name the document
 * uses of itself (a model, a tool, a step) resolves here. What this pass does
 * *not* know is anything outside the file: plugin component types, template
 * producers, graph reachability — that is `resolve.ts`, the second pass.
 */

import {
  BUILTIN_PROVIDERS,
  DEFAULT_OUTCOME,
  INPUTS_NODE,
  OUTCOME_KEY,
  WEAVE_VERSION,
  type AgentSpec,
  type FieldSchema,
  type FieldType,
  type ModelSpec,
  type Outcome,
  type ParsedFlow,
  type SchemaMap,
  type Step,
  type ToolSpec,
  type TransformSpec,
} from './types.js';
import { collectRefs, collectRefsDeep, REF_PATTERN } from './template.js';
import { SpecError } from '../errors.js';

const NAME = /^[a-z][a-z0-9_]*$/;
const FLOW_NAME = /^[a-z][a-z0-9_-]*$/;
const COMPONENT_TYPE = /^[A-Za-z][A-Za-z0-9_-]*$/;

const FIELD_TYPES: readonly FieldType[] = [
  'string',
  'integer',
  'number',
  'boolean',
  'array',
  'object',
];

const TOP_KEYS = new Set([
  'weave',
  'name',
  'description',
  'inputs',
  'models',
  'tools',
  'agent',
  'steps',
  'outcomes',
  'requires',
  'meta',
]);

const STEP_VERBS = ['agent', 'llm', 'tool', 'switch', 'use'] as const;

/**
 * Object keys no document may write, anywhere — including inside `meta` and
 * plugin configs, which are otherwise opaque. A key like `__proto__` is not
 * data: assigned or merged downstream it changes the object it lands on, and
 * a document is caller-supplied JSON. Refused loudly rather than dropped, so
 * a document that carries one learns it here and not from a mangled config.
 */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Parse a Weave document from an already-parsed YAML/JSON value. */
export function parseWeave(raw: unknown): ParsedFlow {
  const doc = asObject(raw, 'the document');

  refuseDangerousKeys(doc, 'the document');
  checkVersion(doc);
  refuseUnknownKeys(doc, TOP_KEYS, 'the document');

  const name = flowName(doc);
  const description = optionalString(doc.description, 'description');
  const inputs = schemaMap(doc.inputs, 'inputs');
  const models = modelsMap(doc.models);
  const tools = toolsMap(doc.tools);
  const requires = requiresMap(doc.requires);
  const meta = optionalObject(doc.meta, 'meta') ?? {};

  const steps = parseSteps(doc, name, models, tools);
  const outcomes = parseOutcomes(doc, steps);

  const flow: ParsedFlow = {
    name,
    inputs,
    models,
    tools,
    steps,
    outcomes,
    requires,
    meta,
  };
  if (description !== undefined) flow.description = description;

  checkNamespaces(flow);
  return flow;
}

function checkVersion(doc: Record<string, unknown>): void {
  if (doc.weave === undefined) {
    throw new SpecError(
      `not a Weave document: the top-level "weave: ${WEAVE_VERSION}" version ` +
        `key is missing. See https://heddle.run/docs for the format.`,
    );
  }
  if (doc.weave !== WEAVE_VERSION) {
    throw new SpecError(
      `this document says "weave: ${JSON.stringify(doc.weave)}", and this ` +
        `heddle reads version ${WEAVE_VERSION}. A newer format needs a newer ` +
        `heddle.`,
    );
  }
}

function flowName(doc: Record<string, unknown>): string {
  const name = doc.name;
  if (typeof name !== 'string' || !FLOW_NAME.test(name)) {
    throw new SpecError(
      `"name" is required: lower-case letters, digits, "_" or "-", starting ` +
        `with a letter. Got ${JSON.stringify(name)}.`,
    );
  }
  return name;
}

// ---------------------------------------------------------------------------
// Schemas

function schemaMap(raw: unknown, where: string): SchemaMap {
  if (raw === undefined || raw === null) return {};
  const entries = asObject(raw, where);

  const schema: SchemaMap = {};
  for (const [field, value] of Object.entries(entries)) {
    if (!NAME.test(field)) {
      throw new SpecError(identifierMessage(`${where}.${field}`, field));
    }
    schema[field] = fieldSchema(value, `${where}.${field}`);
  }
  return schema;
}

function fieldSchema(raw: unknown, where: string): FieldSchema {
  if (typeof raw === 'string') {
    return { type: checkedFieldType(raw, where) };
  }

  const obj = asObject(raw, where);
  refuseUnknownKeys(
    obj,
    new Set(['type', 'description', 'default', 'items', 'fields']),
    where,
  );

  const schema: FieldSchema = {
    type: checkedFieldType(obj.type, where),
  };
  const description = optionalString(obj.description, `${where}.description`);
  if (description !== undefined) schema.description = description;
  if (obj.default !== undefined) schema.default = obj.default;
  if (obj.items !== undefined) {
    if (schema.type !== 'array') {
      throw new SpecError(`${where}: "items" only applies to type: array`);
    }
    schema.items = fieldSchema(obj.items, `${where}.items`);
  }
  if (obj.fields !== undefined) {
    if (schema.type !== 'object') {
      throw new SpecError(`${where}: "fields" only applies to type: object`);
    }
    schema.fields = schemaMap(obj.fields, `${where}.fields`);
  }

  return schema;
}

function checkedFieldType(raw: unknown, where: string): FieldType {
  if (typeof raw === 'string' && FIELD_TYPES.includes(raw as FieldType)) {
    return raw as FieldType;
  }
  throw new SpecError(
    `${where}: "${String(raw)}" is not a type. ` +
      `Types: ${FIELD_TYPES.join(', ')}.`,
  );
}

// ---------------------------------------------------------------------------
// Models and tools

function modelsMap(raw: unknown): Record<string, ModelSpec> {
  if (raw === undefined || raw === null) return {};
  const entries = asObject(raw, 'models');

  const models: Record<string, ModelSpec> = {};
  for (const [name, value] of Object.entries(entries)) {
    if (!NAME.test(name)) {
      throw new SpecError(identifierMessage(`models.${name}`, name));
    }
    models[name] = modelSpec(value, `models.${name}`);
  }
  return models;
}

function modelSpec(raw: unknown, where: string): ModelSpec {
  const obj = asObject(raw, where);

  const provider = obj.provider;
  if (typeof provider !== 'string' || provider.length === 0) {
    throw new SpecError(
      `${where}: "provider" is required — one of ` +
        `${BUILTIN_PROVIDERS.join(', ')}, or a plugin provider type.`,
    );
  }
  const model = obj.model;
  if (typeof model !== 'string' || model.length === 0) {
    throw new SpecError(`${where}: "model" is required — the model id.`);
  }

  const known = new Set(['provider', 'model', 'url', 'api_key', 'params']);
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!known.has(key)) extra[key] = value;
  }
  if (
    BUILTIN_PROVIDERS.includes(provider) &&
    Object.keys(extra).length > 0
  ) {
    throw new SpecError(
      `${where}: unknown ${keyList(Object.keys(extra))} — the "${provider}" ` +
        `provider takes provider, model, url, api_key and params. Extra ` +
        `fields are only meaningful to a plugin provider.`,
    );
  }

  const spec: ModelSpec = { provider, model, extra };
  const url = optionalString(obj.url, `${where}.url`);
  if (url !== undefined) spec.url = url;
  const apiKey = optionalString(obj.api_key, `${where}.api_key`);
  if (apiKey !== undefined) spec.api_key = apiKey;
  const params = optionalObject(obj.params, `${where}.params`);
  if (params !== undefined) {
    checkParams(params, `${where}.params`);
    spec.params = params;
  }

  return spec;
}

/**
 * Only what the runtime sends is writable — a parameter heddle would drop on
 * the floor is refused, not carried as decoration.
 */
function checkParams(params: Record<string, unknown>, where: string): void {
  const known = new Set(['temperature', 'max_tokens', 'top_p']);
  for (const [key, value] of Object.entries(params)) {
    if (!known.has(key)) {
      throw new SpecError(
        `${where}: unknown parameter "${key}". ` +
          `heddle sends: ${[...known].join(', ')}.`,
      );
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new SpecError(
        `${where}.${key} is ${JSON.stringify(value)}, which is not a number. ` +
          `These are sent to the model as written.`,
      );
    }
  }
}

function toolsMap(raw: unknown): Record<string, ToolSpec> {
  if (raw === undefined || raw === null) return {};
  const entries = asObject(raw, 'tools');

  const tools: Record<string, ToolSpec> = {};
  for (const [name, value] of Object.entries(entries)) {
    if (!NAME.test(name)) {
      throw new SpecError(identifierMessage(`tools.${name}`, name));
    }
    tools[name] = toolSpec(name, value, `tools.${name}`);
  }
  return tools;
}

function toolSpec(name: string, raw: unknown, where: string): ToolSpec {
  const obj = asObject(raw, where);
  refuseUnknownKeys(
    obj,
    new Set(['description', 'inputs', 'outputs']),
    where,
  );

  const tool: ToolSpec = {
    name,
    inputs: schemaMap(obj.inputs, `${where}.inputs`),
    outputs: schemaMap(obj.outputs, `${where}.outputs`),
  };
  const description = optionalString(obj.description, `${where}.description`);
  if (description !== undefined) tool.description = description;

  return tool;
}

// ---------------------------------------------------------------------------
// Steps

function parseSteps(
  doc: Record<string, unknown>,
  flowName: string,
  models: Record<string, ModelSpec>,
  tools: Record<string, ToolSpec>,
): Step[] {
  const hasAgent = doc.agent !== undefined;
  const hasSteps = doc.steps !== undefined;

  if (hasAgent && hasSteps) {
    throw new SpecError(
      'a document has "agent" or "steps", not both — "agent" is shorthand ' +
        'for a single-step flow.',
    );
  }
  if (!hasAgent && !hasSteps) {
    throw new SpecError('a document needs "agent" or "steps".');
  }

  if (hasAgent) {
    // The sugar: the whole document is one agent step, named after it.
    return [
      {
        kind: 'agent',
        name: flowName.replaceAll('-', '_'),
        agent: agentSpec(doc.agent, 'agent', models, tools),
      },
    ];
  }

  const list = doc.steps;
  if (!Array.isArray(list) || list.length === 0) {
    throw new SpecError('"steps" must be a non-empty list.');
  }

  return list.map((entry, index) =>
    parseStep(entry, `steps[${index}]`, models, tools),
  );
}

function parseStep(
  raw: unknown,
  where: string,
  models: Record<string, ModelSpec>,
  tools: Record<string, ToolSpec>,
): Step {
  const obj = asObject(raw, where);

  const name = obj.name;
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new SpecError(
      `${where}: "name" is required — ` +
        `lower-case letters, digits and "_", starting with a letter.`,
    );
  }
  const at = `step "${name}"`;

  const verbs = STEP_VERBS.filter((verb) => obj[verb] !== undefined);
  if (verbs.length !== 1) {
    throw new SpecError(
      `${at}: a step declares exactly one of ` +
        `${STEP_VERBS.join(', ')} — found ${verbs.length === 0 ? 'none' : keyList(verbs)}.`,
    );
  }
  const verb = verbs[0];

  const then = optionalString(obj.then, `${at}.then`);
  if (then !== undefined && verb === 'switch') {
    throw new SpecError(
      `${at}: a switch routes through "cases" and "else"; "then" does not apply.`,
    );
  }

  const step = parseVerb(verb, obj, at, models, tools, name);
  if (then !== undefined) step.then = then;
  return step;
}

function parseVerb(
  verb: (typeof STEP_VERBS)[number],
  obj: Record<string, unknown>,
  at: string,
  models: Record<string, ModelSpec>,
  tools: Record<string, ToolSpec>,
  name: string,
): Step {
  switch (verb) {
    case 'agent':
      refuseUnknownKeys(obj, new Set(['name', 'then', 'agent']), at);
      return {
        kind: 'agent',
        name,
        agent: agentSpec(obj.agent, `${at}.agent`, models, tools),
      };

    case 'llm': {
      refuseUnknownKeys(obj, new Set(['name', 'then', 'llm']), at);
      const llm = asObject(obj.llm, `${at}.llm`);
      refuseUnknownKeys(llm, new Set(['model', 'prompt']), `${at}.llm`);
      return {
        kind: 'llm',
        name,
        model: modelRef(llm.model, `${at}.llm.model`, models),
        prompt: requiredTemplate(llm.prompt, `${at}.llm.prompt`),
      };
    }

    case 'tool': {
      refuseUnknownKeys(obj, new Set(['name', 'then', 'tool', 'with']), at);
      const tool = toolRef(obj.tool, `${at}.tool`, tools);
      const args = optionalObject(obj.with, `${at}.with`) ?? {};
      collectRefsDeep(args, `${at}.with`);
      checkToolArgs(tool, args, at);
      return { kind: 'tool', name, tool, args };
    }

    case 'switch': {
      refuseUnknownKeys(
        obj,
        new Set(['name', 'switch', 'cases', 'else']),
        at,
      );
      return parseSwitch(obj, at, name);
    }

    case 'use': {
      refuseUnknownKeys(obj, new Set(['name', 'then', 'use', 'with']), at);
      const use = obj.use;
      if (typeof use !== 'string' || !COMPONENT_TYPE.test(use)) {
        throw new SpecError(
          `${at}: "use" must name a plugin component type, like "RegexRewrite".`,
        );
      }
      const config = optionalObject(obj.with, `${at}.with`) ?? {};
      collectRefsDeep(config, `${at}.with`);
      return { kind: 'use', name, use, config };
    }
  }
}

function parseSwitch(
  obj: Record<string, unknown>,
  at: string,
  name: string,
): Step {
  const on = singleRef(obj.switch, `${at}.switch`);

  const rawCases = asObject(obj.cases ?? {}, `${at}.cases`);
  const cases: Record<string, string> = {};
  for (const [value, target] of Object.entries(rawCases)) {
    if (typeof target !== 'string' || !NAME.test(target)) {
      throw new SpecError(
        `${at}.cases.${value}: the target must be a step or outcome name.`,
      );
    }
    cases[value] = target;
  }

  const fallback = obj.else;
  if (typeof fallback !== 'string' || !NAME.test(fallback)) {
    throw new SpecError(
      `${at}: "else" is required — a switch says where every unmatched ` +
        `value goes; there is no implicit default.`,
    );
  }

  return { kind: 'switch', name, on, cases, else: fallback };
}

function agentSpec(
  raw: unknown,
  where: string,
  models: Record<string, ModelSpec>,
  tools: Record<string, ToolSpec>,
): AgentSpec {
  const obj = asObject(raw, where);
  refuseUnknownKeys(
    obj,
    new Set(['model', 'prompt', 'tools', 'transforms', 'output', 'max_tool_rounds']),
    where,
  );

  const spec: AgentSpec = {
    model: modelRef(obj.model, `${where}.model`, models),
    prompt: requiredTemplate(obj.prompt, `${where}.prompt`),
    tools: agentTools(obj.tools, `${where}.tools`, tools),
    transforms: transformList(obj.transforms, `${where}.transforms`),
  };

  if (obj.output !== undefined) {
    const output = schemaMap(obj.output, `${where}.output`);
    if (Object.keys(output).length === 0) {
      throw new SpecError(`${where}.output: declare at least one field, or omit it.`);
    }
    spec.output = output;
  }
  if (obj.max_tool_rounds !== undefined) {
    const rounds = obj.max_tool_rounds;
    if (typeof rounds !== 'number' || !Number.isInteger(rounds) || rounds < 1) {
      throw new SpecError(
        `${where}.max_tool_rounds must be a whole number of 1 or more.`,
      );
    }
    spec.max_tool_rounds = rounds;
  }

  return spec;
}

function agentTools(
  raw: unknown,
  where: string,
  tools: Record<string, ToolSpec>,
): ToolSpec[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new SpecError(`${where} must be a list of tool names.`);
  }

  return raw.map((name, index) => {
    if (typeof name !== 'string') {
      throw new SpecError(`${where}[${index}] must be a tool name.`);
    }
    const tool = tools[name];
    if (!tool) {
      throw new SpecError(unknownToolMessage(`${where}[${index}]`, name, tools));
    }
    return tool;
  });
}

function transformList(raw: unknown, where: string): TransformSpec[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new SpecError(`${where} must be a list.`);
  }

  return raw.map((entry, index) => {
    const at = `${where}[${index}]`;
    const obj = asObject(entry, at);
    const use = obj.use;
    if (typeof use !== 'string' || !COMPONENT_TYPE.test(use)) {
      throw new SpecError(
        `${at}: "use" must name a plugin transform type, like "SecretScrub".`,
      );
    }
    const { use: _use, ...config } = obj;
    return { use, config };
  });
}

function modelRef(
  raw: unknown,
  where: string,
  models: Record<string, ModelSpec>,
): ModelSpec {
  if (typeof raw === 'string') {
    const model = models[raw];
    if (!model) {
      throw new SpecError(
        `${where}: "${raw}" is not in "models". ` +
          `Declared: ${nameList(Object.keys(models))}.`,
      );
    }
    return model;
  }
  return modelSpec(raw, where);
}

function toolRef(
  raw: unknown,
  where: string,
  tools: Record<string, ToolSpec>,
): ToolSpec {
  if (typeof raw !== 'string') {
    throw new SpecError(`${where} must be a tool name from "tools".`);
  }
  const tool = tools[raw];
  if (!tool) {
    throw new SpecError(unknownToolMessage(where, raw, tools));
  }
  return tool;
}

function checkToolArgs(
  tool: ToolSpec,
  args: Record<string, unknown>,
  at: string,
): void {
  for (const key of Object.keys(args)) {
    if (!(key in tool.inputs)) {
      throw new SpecError(
        `${at}: "${tool.name}" takes no input "${key}". ` +
          `Declared: ${nameList(Object.keys(tool.inputs))}.`,
      );
    }
  }
  for (const [field, schema] of Object.entries(tool.inputs)) {
    if (schema.default === undefined && !(field in args)) {
      throw new SpecError(
        `${at}: "${tool.name}" requires "${field}" (it has no default), ` +
          `and "with" does not set it.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Outcomes

function parseOutcomes(doc: Record<string, unknown>, steps: Step[]): Outcome[] {
  if (doc.outcomes === undefined || doc.outcomes === null) {
    // The implicit outcome: `done`, echoing what the last step wrote.
    return [{ name: DEFAULT_OUTCOME }];
  }

  const entries = asObject(doc.outcomes, 'outcomes');
  const names = Object.keys(entries);
  if (names.length === 0) {
    throw new SpecError('"outcomes" must declare at least one outcome, or be omitted.');
  }

  return names.map((name) => {
    if (!NAME.test(name)) {
      throw new SpecError(identifierMessage(`outcomes.${name}`, name));
    }
    const payload = asObject(entries[name] ?? {}, `outcomes.${name}`);
    if (OUTCOME_KEY in payload) {
      throw new SpecError(
        `outcomes.${name}: "${OUTCOME_KEY}" is the key heddle writes the ` +
          `outcome's own name under — pick another.`,
      );
    }
    collectRefsDeep(payload, `outcomes.${name}`);
    return { name, payload };
  });
}

// ---------------------------------------------------------------------------
// Cross-cutting checks

function checkNamespaces(flow: ParsedFlow): void {
  const seen = new Set<string>();

  for (const step of flow.steps) {
    if (step.name === INPUTS_NODE) {
      throw new SpecError(
        `step "${INPUTS_NODE}": that name is reserved — it is the namespace ` +
          `flow inputs are referenced through.`,
      );
    }
    if (seen.has(step.name)) {
      throw new SpecError(duplicateNameMessage(step.name));
    }
    seen.add(step.name);
  }

  for (const outcome of flow.outcomes) {
    if (outcome.name === INPUTS_NODE) {
      throw new SpecError(
        `outcome "${INPUTS_NODE}": that name is reserved for flow inputs.`,
      );
    }
    if (seen.has(outcome.name)) {
      throw new SpecError(duplicateNameMessage(outcome.name));
    }
    seen.add(outcome.name);
  }
}

function requiresMap(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  const entries = asObject(raw, 'requires');

  const requires: Record<string, string> = {};
  for (const [componentType, range] of Object.entries(entries)) {
    if (typeof range !== 'string' || range.length === 0) {
      throw new SpecError(
        `requires.${componentType} must be a version range, like "^1.0".`,
      );
    }
    requires[componentType] = range;
  }
  return requires;
}

// ---------------------------------------------------------------------------
// Small helpers

function singleRef(raw: unknown, where: string): string {
  if (typeof raw === 'string') {
    const match = /^\{\{([^{}]*)\}\}$/.exec(raw.trim());
    const ref = match?.[1].trim();
    if (ref !== undefined && REF_PATTERN.test(ref)) return ref;
  }
  throw new SpecError(
    `${where} must be exactly one reference, like "{{triage.status}}".`,
  );
}

function requiredTemplate(raw: unknown, where: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new SpecError(`${where} is required.`);
  }
  collectRefs(raw, where);
  return raw;
}

function refuseDangerousKeys(value: unknown, where: string): void {
  if (value === null || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      refuseDangerousKeys(entry, `${where}[${index}]`),
    );
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(key)) {
      throw new SpecError(
        `${where}: the key "${key}" is not writable anywhere in a document.`,
      );
    }
    refuseDangerousKeys(child, `${where}.${key}`);
  }
}

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SpecError(`${where} must be a mapping of keys to values.`);
  }
  return value as Record<string, unknown>;
}

function optionalObject(
  value: unknown,
  where: string,
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  return asObject(value, where);
}

function optionalString(value: unknown, where: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new SpecError(`${where} must be a string.`);
  }
  return value;
}

function refuseUnknownKeys(
  obj: Record<string, unknown>,
  known: Set<string>,
  where: string,
): void {
  const unknown = Object.keys(obj).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new SpecError(
      `${where}: unknown ${keyList(unknown)}. ` +
        `Allowed: ${[...known].join(', ')}.`,
    );
  }
}

function identifierMessage(where: string, name: string): string {
  return (
    `${where}: "${name}" is not a usable name — lower-case letters, digits ` +
    `and "_", starting with a letter.`
  );
}

function duplicateNameMessage(name: string): string {
  return (
    `"${name}" is declared twice. Steps and outcomes share one namespace — ` +
    `a branch target has to mean one thing.`
  );
}

function unknownToolMessage(
  where: string,
  name: string,
  tools: Record<string, ToolSpec>,
): string {
  return (
    `${where}: "${name}" is not in "tools". A step only uses tools the ` +
    `document declares. Declared: ${nameList(Object.keys(tools))}.`
  );
}

function keyList(keys: string[]): string {
  return `key${keys.length === 1 ? '' : 's'} ${keys.map((key) => `"${key}"`).join(', ')}`;
}

function nameList(names: string[]): string {
  return names.length > 0 ? names.join(', ') : '(none)';
}
