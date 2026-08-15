import type { FieldSchema, ToolStep } from '../spec/types.js';
import { resolveValues } from '../spec/template.js';
import { State } from '../state/state.js';
import type { NodeExecutor, Dependencies } from './types.js';
import { invokeTool } from '../tool/invoke.js';
import { RunError, ToolError } from '../errors.js';

/**
 * A direct tool invocation. The `with:` block, rendered against the run's
 * state, is the whole of what the tool receives — a tool step's inputs are
 * its bindings, never the ambient state.
 *
 * The declared outputs are a contract, both ways: the step writes exactly
 * them, and a tool that answers without one (or with the wrong shape of one)
 * fails the step rather than silently shorting whatever referenced it.
 */
export class ToolStepExecutor implements NodeExecutor {
  constructor(
    private readonly step: ToolStep,
    private readonly deps: Dependencies,
  ) {}

  branch(): string {
    return '';
  }

  async execute(
    signal: AbortSignal | undefined,
    input: State,
  ): Promise<State> {
    const args = {
      ...defaultsOf(this.step.tool.inputs),
      ...(resolveValues(
        this.step.args,
        input,
        `step "${this.step.name}"`,
      ) as Record<string, unknown>),
    };

    const result = await invokeTool(
      signal,
      this.resolveTool(),
      args,
      this.deps.toolExecutor,
    );

    return new State(this.checkedOutput(result.output));
  }

  private resolveTool() {
    const registry = this.deps.toolRegistry;
    if (!registry) {
      throw new RunError(
        `step "${this.step.name}": no tool registry configured`,
      );
    }

    const definition = registry.lookup(this.step.tool.name);
    if (!definition) {
      throw new ToolError(
        `step "${this.step.name}": tool "${this.step.tool.name}" not found`,
      );
    }
    return definition;
  }

  private checkedOutput(
    output: Record<string, unknown>,
  ): Record<string, unknown> {
    const declared = this.step.tool.outputs;
    const kept: Record<string, unknown> = {};

    for (const [field, schema] of Object.entries(declared)) {
      if (!(field in output)) {
        throw new ToolError(
          `"${this.step.tool.name}" declares the output "${field}" and did ` +
            `not write it. A declared output is a contract — the tool ` +
            `returned: ${keysOf(output)}.`,
        );
      }
      const value = output[field];
      if (!matchesType(value, schema)) {
        throw new ToolError(
          `"${this.step.tool.name}" wrote ${JSON.stringify(value)} for ` +
            `"${field}", which is declared ${schema.type}.`,
        );
      }
      kept[field] = value;
    }

    return kept;
  }
}

function defaultsOf(
  inputs: Record<string, FieldSchema>,
): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const [field, schema] of Object.entries(inputs)) {
    if (schema.default !== undefined) defaults[field] = schema.default;
  }
  return defaults;
}

function matchesType(value: unknown, schema: FieldSchema): boolean {
  switch (schema.type) {
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'array':
      return Array.isArray(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
}

function keysOf(output: Record<string, unknown>): string {
  const keys = Object.keys(output);
  return keys.length > 0 ? keys.map((key) => `"${key}"`).join(', ') : 'nothing';
}
