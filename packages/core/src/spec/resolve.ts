/**
 * The second pass: what the document means, checked against what exists.
 *
 * `parse.ts` proved the document is well-formed on its own. This pass proves
 * it holds together as a graph and against the loaded plugins: every branch
 * target lands, every `{{ref}}` names a producer that runs on every path to
 * its consumer, every `use:`/transform/provider type is one a plugin actually
 * provides (validated by the plugin's own schema), and every `requires` range
 * is satisfied. Throws a `SpecError` naming every problem at once.
 *
 * `flowEdges` and `refsOf` live here because validation and compilation must
 * agree on them: the graph that is checked is the graph that runs.
 */

import {
  DEFAULT_OUTCOME,
  INPUTS_NODE,
  type Outcome,
  type ParsedFlow,
  type Step,
} from './types.js';
import { collectRefs, collectRefsDeep, refParts } from './template.js';
import type { PluginRegistry } from '../plugin/registry.js';
import type { PluginComponent, PluginNode } from '../plugin/types.js';
import { BUILTIN_PROVIDERS, type ModelSpec } from './types.js';
import { SpecError } from '../errors.js';

/** One derived control-flow edge. `branch` is set only out of a switch. */
export interface SpecEdge {
  from: string;
  branch?: string;
  to: string;
}

/**
 * The control flow the document implies: fall-through in list order, `then`
 * jumps, a switch's cases and `else`, and the last step falling through to
 * `done`.
 */
export function flowEdges(flow: ParsedFlow): SpecEdge[] {
  const edges: SpecEdge[] = [];
  const steps = flow.steps;

  if (steps.length > 0) {
    edges.push({ from: INPUTS_NODE, to: steps[0].name });
  }

  steps.forEach((step, index) => {
    if (step.kind === 'switch') {
      for (const target of switchTargets(step.cases, step.else)) {
        edges.push({ from: step.name, branch: target, to: target });
      }
      return;
    }

    const to =
      step.then ?? steps[index + 1]?.name ?? DEFAULT_OUTCOME;
    edges.push({ from: step.name, to });
  });

  return edges;
}

function switchTargets(
  cases: Record<string, string>,
  fallback: string,
): string[] {
  return [...new Set([...Object.values(cases), fallback])];
}

/** Every reference a step makes, across all its templated surfaces. */
export function refsOf(step: Step): string[] {
  switch (step.kind) {
    case 'agent':
      return collectRefs(step.agent.prompt, `step "${step.name}"`);
    case 'llm':
      return collectRefs(step.prompt, `step "${step.name}"`);
    case 'tool':
      return collectRefsDeep(step.args, `step "${step.name}"`);
    case 'switch':
      return [step.on];
    case 'use':
      return collectRefsDeep(step.config, `step "${step.name}"`);
  }
}

export function refsOfOutcome(outcome: Outcome): string[] {
  return collectRefsDeep(outcome.payload ?? {}, `outcome "${outcome.name}"`);
}

/**
 * The keys a step's node writes, or undefined where the document cannot know
 * (a plugin step whose manifest declares no outputs).
 */
export function producedKeys(
  step: Step,
  registry?: PluginRegistry,
): string[] | undefined {
  switch (step.kind) {
    case 'agent': {
      const keys = step.agent.output
        ? Object.keys(step.agent.output)
        : ['result'];
      return step.agent.transforms.length > 0
        ? [...keys, 'transform_status', 'transform_reason', 'transform_name', 'transform_phase']
        : keys;
    }
    case 'llm':
      return ['text'];
    case 'tool':
      return Object.keys(step.tool.outputs);
    case 'switch':
      return [];
    case 'use': {
      const def = registry?.nodeDef(step.use);
      const outputs = def?.inferOutputs?.(
        pluginComponentOf(step.use, step.name, step.config) as PluginNode,
      );
      return outputs?.map((output) => output.title);
    }
  }
}

/** Check a parsed flow against its own graph and the loaded plugins. */
export function resolveFlow(
  flow: ParsedFlow,
  registry?: PluginRegistry,
): void {
  const problems = [
    ...targetProblems(flow),
    ...refProblems(flow, registry),
    ...pluginProblems(flow, registry),
    ...requiresProblems(flow, registry),
  ];

  if (problems.length > 0) {
    throw new SpecError(problems.join('\n'));
  }
}

// ---------------------------------------------------------------------------
// Targets and reachability

function targetProblems(flow: ParsedFlow): string[] {
  const problems: string[] = [];
  const stepIndex = new Map(flow.steps.map((step, index) => [step.name, index]));
  const outcomeNames = new Set(flow.outcomes.map((outcome) => outcome.name));

  const checkTarget = (from: string, fromIndex: number, target: string): void => {
    if (outcomeNames.has(target)) return;

    const targetIndex = stepIndex.get(target);
    if (targetIndex === undefined) {
      problems.push(
        `step "${from}" routes to "${target}", which is not a step or an ` +
          `outcome of this document.`,
      );
      return;
    }
    if (targetIndex <= fromIndex) {
      problems.push(
        `step "${from}" routes back to "${target}". Control flows forward ` +
          `in v1 — loops are reserved for a later format version.`,
      );
    }
  };

  flow.steps.forEach((step, index) => {
    if (step.kind === 'switch') {
      for (const target of switchTargets(step.cases, step.else)) {
        checkTarget(step.name, index, target);
      }
      return;
    }
    if (step.then !== undefined) {
      checkTarget(step.name, index, step.then);
    }
  });

  const last = flow.steps.at(-1);
  if (
    last &&
    last.kind !== 'switch' &&
    last.then === undefined &&
    !outcomeNames.has(DEFAULT_OUTCOME)
  ) {
    problems.push(
      `step "${last.name}" falls through to the outcome "${DEFAULT_OUTCOME}", ` +
        `which this document does not define. Give the step a "then", or ` +
        `define "${DEFAULT_OUTCOME}" under "outcomes".`,
    );
  }

  if (problems.length > 0) return problems;

  // Reachability is only meaningful once every edge lands somewhere.
  const reached = reachable(flowEdges(flow), INPUTS_NODE, undefined);
  for (const step of flow.steps) {
    if (!reached.has(step.name)) {
      problems.push(`step "${step.name}" is unreachable.`);
    }
  }
  for (const outcome of flow.outcomes) {
    if (!reached.has(outcome.name)) {
      problems.push(
        `outcome "${outcome.name}" is declared but no path reaches it.`,
      );
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// References

function refProblems(
  flow: ParsedFlow,
  registry?: PluginRegistry,
): string[] {
  const problems: string[] = [];
  const edges = flowEdges(flow);
  const stepsByName = new Map(flow.steps.map((step) => [step.name, step]));

  const consumers: Array<{ name: string; refs: string[] }> = [
    ...flow.steps.map((step) => ({ name: step.name, refs: refsOf(step) })),
    ...flow.outcomes.map((outcome) => ({
      name: outcome.name,
      refs: refsOfOutcome(outcome),
    })),
  ];

  for (const consumer of consumers) {
    for (const ref of consumer.refs) {
      problems.push(
        ...refProblem(ref, consumer.name, flow, stepsByName, edges, registry),
      );
    }
  }

  return problems;
}

function refProblem(
  ref: string,
  consumer: string,
  flow: ParsedFlow,
  stepsByName: Map<string, Step>,
  edges: SpecEdge[],
  registry?: PluginRegistry,
): string[] {
  const { source, key } = refParts(ref);
  const at = `"${consumer}" references {{${ref}}}`;

  if (source === consumer) {
    return [`${at}, which is itself — a step cannot read its own output.`];
  }

  let produced: string[] | undefined;
  if (source === INPUTS_NODE) {
    produced = Object.keys(flow.inputs);
  } else {
    const producer = stepsByName.get(source);
    if (!producer) {
      return [
        `${at}, but "${source}" is not "${INPUTS_NODE}" or a step of this ` +
          `document.`,
      ];
    }
    produced = producedKeys(producer, registry);
  }

  if (produced !== undefined && !produced.includes(key)) {
    return [
      `${at}, but "${source}" writes ${writtenList(produced)} — never "${key}".`,
    ];
  }

  // The producer must run on every path that reaches the consumer, or the
  // value is a hole some inputs would fall into at run time.
  if (source !== INPUTS_NODE) {
    const avoiding = reachable(edges, INPUTS_NODE, source);
    if (avoiding.has(consumer)) {
      return [
        `${at}, but a path from ${INPUTS_NODE} reaches "${consumer}" without ` +
          `running "${source}" — the value would be missing on it.`,
      ];
    }
  }

  return [];
}

function writtenList(keys: string[]): string {
  return keys.length > 0
    ? keys.map((key) => `"${key}"`).join(', ')
    : 'nothing';
}

function reachable(
  edges: SpecEdge[],
  from: string,
  avoiding: string | undefined,
): Set<string> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge.to);
    adjacency.set(edge.from, list);
  }

  const seen = new Set<string>([from]);
  const pending = [from];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    if (current === avoiding) continue;
    for (const next of adjacency.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      pending.push(next);
    }
  }

  seen.delete(from);
  return seen;
}

// ---------------------------------------------------------------------------
// Plugins

function pluginProblems(
  flow: ParsedFlow,
  registry?: PluginRegistry,
): string[] {
  const problems: string[] = [];

  for (const step of flow.steps) {
    if (step.kind === 'use') {
      problems.push(
        ...componentProblems('node', step.use, step.name, step.config, registry),
      );
    }
    if (step.kind === 'agent') {
      for (const transform of step.agent.transforms) {
        problems.push(
          ...componentProblems(
            'transform',
            transform.use,
            step.name,
            transform.config,
            registry,
          ),
        );
      }
      problems.push(...providerProblems(step.agent.model, step.name, registry));
    }
    if (step.kind === 'llm') {
      problems.push(...providerProblems(step.model, step.name, registry));
    }
  }

  return problems;
}

function componentProblems(
  kind: 'node' | 'transform',
  componentType: string,
  stepName: string,
  config: Record<string, unknown>,
  registry?: PluginRegistry,
): string[] {
  const def =
    kind === 'node'
      ? registry?.nodeDef(componentType)
      : registry?.transformDef(componentType);

  if (!def) {
    const actual = registry?.kindOf(componentType);
    if (actual) {
      return [
        `step "${stepName}" uses "${componentType}", which a plugin provides ` +
          `as a ${actual} rather than a ${kind}.`,
      ];
    }
    return [
      `step "${stepName}" uses "${componentType}", which no loaded plugin ` +
        `provides.\n  Loaded plugins: ${registry?.describe() ?? 'none'}\n` +
        `  If it comes from a plugin, load it with: --plugin <module>`,
    ];
  }

  try {
    def.validate?.(pluginComponentOf(componentType, stepName, config));
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
  return [];
}

function providerProblems(
  model: ModelSpec,
  stepName: string,
  registry?: PluginRegistry,
): string[] {
  if (BUILTIN_PROVIDERS.includes(model.provider)) return [];

  const def = registry?.providerDef(model.provider);
  if (def) {
    try {
      def.validate?.(
        pluginComponentOf(model.provider, `${stepName}-model`, {
          model: model.model,
          ...model.extra,
        }),
      );
    } catch (err) {
      return [err instanceof Error ? err.message : String(err)];
    }
    return [];
  }

  const kind = registry?.kindOf(model.provider);
  if (kind) {
    return [
      `step "${stepName}" names the provider "${model.provider}", which a ` +
        `plugin provides as a ${kind} rather than a provider.`,
    ];
  }
  return [
    `step "${stepName}" names the provider "${model.provider}". Builtin ` +
      `providers: ${BUILTIN_PROVIDERS.join(', ')}. Anything else comes from ` +
      `a plugin — load it with --plugin <module>.\n` +
      `  Loaded plugins: ${registry?.describe() ?? 'none'}`,
  ];
}

export function pluginComponentOf(
  componentType: string,
  name: string,
  config: Record<string, unknown>,
): PluginComponent {
  return {
    ...config,
    componentType,
    name,
    id: name,
    metadata: {},
  };
}

// ---------------------------------------------------------------------------
// Requires

function requiresProblems(
  flow: ParsedFlow,
  registry?: PluginRegistry,
): string[] {
  const problems: string[] = [];

  for (const [componentType, range] of Object.entries(flow.requires)) {
    const version = registry?.versionOf(componentType);
    if (version === undefined) {
      problems.push(
        `requires: "${componentType}" is pinned to "${range}", but no loaded ` +
          `plugin provides it.`,
      );
      continue;
    }
    if (!satisfies(version, range)) {
      problems.push(
        `requires: "${componentType}" is pinned to "${range}", but the ` +
          `loaded plugin provides ${version}.`,
      );
    }
  }

  return problems;
}

/**
 * The slice of semver ranges a document may write: exact (`1.2.3`), caret
 * (`^1.2`), tilde (`~1.2.3`), and floor (`>=1.2`). Missing parts are zero.
 */
export function satisfies(version: string, range: string): boolean {
  const trimmed = range.trim();
  const actual = parseVersion(version);
  if (!actual) return false;

  if (trimmed.startsWith('^')) {
    const wanted = parseVersion(trimmed.slice(1));
    return (
      wanted !== undefined &&
      actual[0] === wanted[0] &&
      atLeast(actual, wanted)
    );
  }
  if (trimmed.startsWith('~')) {
    const wanted = parseVersion(trimmed.slice(1));
    return (
      wanted !== undefined &&
      actual[0] === wanted[0] &&
      actual[1] === wanted[1] &&
      atLeast(actual, wanted)
    );
  }
  if (trimmed.startsWith('>=')) {
    const wanted = parseVersion(trimmed.slice(2));
    return wanted !== undefined && atLeast(actual, wanted);
  }

  const wanted = parseVersion(trimmed);
  return (
    wanted !== undefined &&
    actual[0] === wanted[0] &&
    actual[1] === wanted[1] &&
    actual[2] === wanted[2]
  );
}

type Version = [number, number, number];

function parseVersion(text: string): Version | undefined {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/.exec(text.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function atLeast(actual: Version, wanted: Version): boolean {
  if (actual[0] !== wanted[0]) return actual[0] > wanted[0];
  if (actual[1] !== wanted[1]) return actual[1] > wanted[1];
  return actual[2] >= wanted[2];
}
