/**
 * The Weave document, parsed: what a `weave.yaml` says, in the shape the rest
 * of heddle consumes.
 *
 * Everything here is data that survived validation — names resolved, templates
 * checked, unknown keys refused — so a `ParsedFlow` in hand is one that
 * compiles. The wire format is snake_case and so are these fields: one
 * vocabulary, no case mapping between the file and the code.
 * `docs/weave-spec-design.md` is the format's design; `parse.ts` and
 * `resolve.ts` are the two passes that build this.
 */

/** The format version this build of heddle reads. */
export const WEAVE_VERSION = 1;

export type FieldType =
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'array'
  | 'object';

/**
 * One field in a schema map — the longhand form. The shorthand (`alert:
 * string`) normalizes to this at parse.
 */
export interface FieldSchema {
  type: FieldType;
  description?: string;
  /** A default makes the field optional; without one it is required. */
  default?: unknown;
  /** Element schema, when `type` is `array`. */
  items?: FieldSchema;
  /** Field schemas, when `type` is `object`. */
  fields?: SchemaMap;
}

/**
 * Everywhere the format wants a schema — flow `inputs`, tool `inputs` and
 * `outputs`, an agent's `output` — it is this: field name to schema.
 */
export type SchemaMap = Record<string, FieldSchema>;

/** The providers heddle has a client for. Anything else comes from a plugin. */
export const BUILTIN_PROVIDERS: readonly string[] = [
  'openai',
  'openai-compatible',
  'ollama',
  'vllm',
];

/**
 * A model configuration: an entry under `models`, or the same shape inline
 * where a model is expected.
 */
export interface ModelSpec {
  /** A builtin provider name, or a plugin-registered provider type. */
  provider: string;
  /** The model id the endpoint knows: `gpt-4o-mini`, `qwen2.5:7b`. */
  model: string;
  url?: string;
  /** A literal, or a `$VAR` reference resolved from the environment. */
  api_key?: string;
  /** Generation parameters, passed through: `temperature`, `max_tokens`, `top_p`. */
  params?: Record<string, unknown>;
  /**
   * Whatever else the entry carried — meaningful only to a plugin provider,
   * refused by the builtins.
   */
  extra: Record<string, unknown>;
}

export interface ToolSpec {
  name: string;
  description?: string;
  inputs: SchemaMap;
  outputs: SchemaMap;
}

/** A plugin transform on an agent: `use:` names the type, the rest is config. */
export interface TransformSpec {
  use: string;
  config: Record<string, unknown>;
}

export interface AgentSpec {
  model: ModelSpec;
  /** The system prompt. `{{inputs.x}}` / `{{step.key}}` templates resolve per run. */
  prompt: string;
  /** Names into the document's `tools` map. */
  tools: ToolSpec[];
  transforms: TransformSpec[];
  /**
   * Structured output: when declared, the model is held to a JSON object with
   * exactly these keys, and the step writes them instead of `result`.
   */
  output?: SchemaMap;
  max_tool_rounds?: number;
}

interface StepBase {
  name: string;
  /** Where control goes next: a later step or an outcome. Absent = fall through. */
  then?: string;
}

export interface AgentStep extends StepBase {
  kind: 'agent';
  agent: AgentSpec;
}

/** A single completion, no tools. Writes `text`. */
export interface LlmStep extends StepBase {
  kind: 'llm';
  model: ModelSpec;
  prompt: string;
}

/** A direct tool invocation. Writes the tool's declared outputs — checked. */
export interface ToolStep extends StepBase {
  kind: 'tool';
  tool: ToolSpec;
  /** The call's arguments; string values may carry `{{ref}}` templates. */
  args: Record<string, unknown>;
}

/**
 * Branching. `on` is a single template reference, compared by string equality
 * against `cases` keys; `else` is required — there is no implicit default.
 */
export interface SwitchStep extends StepBase {
  kind: 'switch';
  on: string;
  cases: Record<string, string>;
  else: string;
}

/** A plugin-defined step: `use:` names the component type, `with` its config. */
export interface UseStep extends StepBase {
  kind: 'use';
  use: string;
  config: Record<string, unknown>;
}

export type Step = AgentStep | LlmStep | ToolStep | SwitchStep | UseStep;

export type StepKind = Step['kind'];

/**
 * A terminal state. `payload` maps output names to literals or templates;
 * absent means "echo what the last step wrote", which is what the implicit
 * `done` outcome does.
 */
export interface Outcome {
  name: string;
  payload?: Record<string, unknown>;
}

/** The key every outcome writes beside its payload: which outcome it was. */
export const OUTCOME_KEY = 'outcome';

/** The synthetic node flow inputs are read through, and their ref namespace. */
export const INPUTS_NODE = 'inputs';

/** The outcome a document without an `outcomes` block gets, and the default fall-through target. */
export const DEFAULT_OUTCOME = 'done';

export interface ParsedFlow {
  name: string;
  description?: string;
  inputs: SchemaMap;
  models: Record<string, ModelSpec>;
  tools: Record<string, ToolSpec>;
  steps: Step[];
  outcomes: Outcome[];
  /** Plugin component type → semver range the document requires. */
  requires: Record<string, string>;
  meta: Record<string, unknown>;
}

/** Every tool name the flow's steps actually reference. */
export function collectToolNames(flow: ParsedFlow): string[] {
  const names = new Set<string>();

  for (const step of flow.steps) {
    if (step.kind === 'agent') {
      for (const tool of step.agent.tools) names.add(tool.name);
    }
    if (step.kind === 'tool') names.add(step.tool.name);
  }

  return [...names];
}

/** The step and outcome names of a flow, in declaration order. */
export function targetNames(flow: ParsedFlow): string[] {
  return [
    ...flow.steps.map((step) => step.name),
    ...flow.outcomes.map((outcome) => outcome.name),
  ];
}
