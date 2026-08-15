# Weave: heddle's own agent definition format

> Internal design notes, not user documentation; see https://heddle.run/docs.

All paths are relative to the repository root. This document proposes replacing the Open Agent
Spec (the vendored Oracle `agentspec` SDK plus heddle's adapters around it) with a format heddle
owns. The format is named **Weave** — a heddle is the loom part that lifts the threads; the weave
is the pattern the loom actually produces. The default filename is `weave.yaml`.

---

## 1. Why leave Open Agent Spec

Every reason below is a cost the tree is paying today, not a preference.

**We already forked the format's validator.** `vendor/agentspec/VENDOR.md` documents three local
patches across eight files, made because every SDK union is a closed
`z.discriminatedUnion("componentType", …)` fixed at module load. The refresh procedure
(`rsync --delete`) silently discards the patches; the only safety net is one test
(`packages/core/src/plugin/__tests__/vendor-schema-registration.test.ts`). A format we have to
patch to use is a format we already maintain — without the authority to change it.

**The workarounds are bigger than the benefit.** `packages/core/src/spec/open-unions.ts` replaces
three SDK unions with `z.any().transform(...)` so plugin components can parse at all — which means
heddle's validation of any plugin component is materially *weaker* than the SDK's validation of
builtins. `packages/core/src/plugin/deserializer.ts` re-declares `PROTOCOL_FIELDS`,
`DANGEROUS_KEYS`, `OPAQUE_FIELDS` and `PROPERTY_ARRAY_FIELDS` because the SDK doesn't export its
builtin deserialization plugin, and recovers an unexported type via
`Parameters<ComponentDeserializationPlugin['deserialize']>[0]`. `ToolUnion` is still closed and
unpriced. The now-deleted placeholder-substitution module (`docs/plugin-system-design.md` §8) was
a whole subsystem whose only job was smuggling plugin components past the SDK.

**The wire format taxes every author.** A five-node linear-flow-plus-branch costs the annotated
template (`.claude/skills/create-heddle-agent/template/spec.yaml`) 236 lines: `$referenced_components`
declared once and pointed at by `$component_ref` everywhere, `component_type` / `id` / `name` /
`metadata: {}` ceremony on every component, explicit `ControlFlowEdge` and `DataFlowEdge` objects
each with their own id and name, and snake_case on the wire camelCased by the SDK on the way in.
The template carries comments like "the `$component_ref` wiring is unforgiving" because it is.

**heddle already disagrees with the spec it validates.** Eight of fourteen node types deserialize
cleanly and are then refused by name (`packages/core/src/spec/adapter.ts`,
`website/content/docs/nodes.mdx`). `humanInTheLoop`, `toolboxes`, datastores, MCP components,
`Swarm`, `MapNode` and the parallel nodes are all accepted by the schema and unimplemented.
Declared `outputs` are documentation, not contract: an `LlmNode` writes only `generated_text`, an
`AgentNode` writes only `result`, and a data edge reading a declared-but-fictional output
validates clean and silently delivers nothing (`.claude/skills/create-heddle-agent/SKILL.md`,
"Gotchas"). Data edges don't isolate anything — every node also sees the merged outputs of all
prior nodes, and identically-titled outputs overwrite one another (`website/content/docs/flows.mdx`).
A spec that promises what the runtime doesn't do, and hides what it does, is worse than no spec.

**What we keep.** The decisions around the spec are right and survive unchanged: plugins are named
by type and never by module; middleware belongs to the operator and encoders to the request, never
to the document (`packages/core/src/plugin/flow-preprocess.ts`); sandbox, mounts and sessions are
operator concerns carried by the bundle manifest, not the spec (`packages/core/src/bundle/format.ts`).
Weave changes what the document says, not who gets to say what.

---

## 2. Goals

1. **Human-writable first.** One file, no ids, no refs, no ceremony. Names are identity; wiring
   is implied by order and by reference. The 90% case — one agent with tools — should fit in
   fifteen lines. The template's 236-line flow should fit in sixty.
2. **Truthful.** Everything in the document is enforced, and nothing in it is documentation-only.
   If a field validates, the runtime honors it; if the runtime doesn't implement something, the
   format cannot express it. No aspirational surface.
3. **Open by construction.** Extension points are open at the schema level: a plugin component is
   validated by a schema the plugin registers, not waved through by a widened union. There is no
   closed union anywhere in the format.
4. **Deterministic data flow.** Step outputs are namespaced by step name; a step's inputs are
   exactly the references its config makes. No merged bag of state, no silent overwrites, no
   `branching_mapping_key`, no fallback to "the first string value in state".
5. **One vocabulary.** The wire format is snake_case and the TypeScript types use the same field
   names. No `snakeToCamel`, no dual identity for every key.
6. **Boring to validate.** The core structure is describable in plain JSON Schema, published, so
   editors autocomplete it via `$schema` and third parties can validate without our SDK.

### Non-goals

- **Interop with Open Agent Spec documents.** That was the constraint that produced the fork.
  A converter (`heddle migrate`, §10) covers the transition; ongoing bidirectional compatibility
  is explicitly abandoned.
- **Expressing what the runtime doesn't run.** No parallel nodes, no sub-flows, no map nodes in
  v1. §11 lists how the format grows when the runtime does.
- **Carrying operator concerns.** Sandbox policy, mounts, sessions, middleware, encoders, plugin
  module paths: all stay out, same as today.

---

## 3. The format by example

### 3.1 The minimal case: one agent

A document with no `steps` and a top-level `agent` is sugar for a one-step flow whose single step
is named after the document. This replaces today's standalone `Agent` documents
(`examples/coding-agent/agents/*.yaml`), which validate but cannot run — under Weave they run.

```yaml
weave: 1
name: notetaker
description: Transcribes a recording and writes a summary note.

inputs:
  recording: string

agent:
  model:
    provider: ollama
    model: qwen2.5:7b
  prompt: |
    Transcribe the recording at {{inputs.recording}} with the transcribe
    tool, then write a one-paragraph summary note.
  tools: [transcribe]
```

### 3.2 The full case: the on-call triage template, rewritten

The 236-line annotated template becomes:

```yaml
weave: 1
name: oncall-triage
description: >
  Triages an alert: finds the service's runbook, searches recent logs, and
  writes a triage note. Hands off to a human when the payload names no service.

inputs:
  alert: string
  service: string

models:
  fast:
    provider: openai
    model: gpt-4o-mini
    api_key: $OPENAI_API_KEY

tools:
  runbook_lookup:
    description: >
      Look up the operational runbook for a service. Returns found=false when
      the service has no runbook, in which case say so.
    inputs:
      service: string
    outputs:
      found: boolean
      runbook: string
  log_search:
    description: Search recent log lines for a regular expression.
    inputs:
      pattern: string
      limit: { type: integer, default: 5 }
    outputs:
      matches: string
      count: integer

steps:
  - name: triage
    agent:
      model: fast
      prompt: |
        You are an on-call triage assistant. Work the alert below and produce
        a short triage note.

        1. Call runbook_lookup for the named service. If no runbook is found,
           say so plainly rather than inventing steps.
        2. Call log_search with a pattern drawn from the alert.
        3. Answer with: what is broken, the evidence, and the first action
           from the runbook. Three sentences, no preamble.

        Service: {{inputs.service}}
        Alert: {{inputs.alert}}
      tools: [runbook_lookup, log_search]
      transforms:
        - use: SecretScrub
          phase: both
          patterns:
            - 'sk-[A-Za-z0-9]{16,}'
            - '\bAKIA[0-9A-Z]{16}\b'
          replacement: '[REDACTED]'

  - name: route
    switch: '{{triage.transform_status}}'
    cases:
      rejected: handoff
    else: done

outcomes:
  done:
    note: '{{triage.result}}'
  handoff:
    note: '{{triage.result}}'
```

Everything the old document said is still said. What disappeared: every `id`, every
`$component_ref`, every `metadata: {}`, both edge lists, the `StartNode`, both `EndNode`s, the
explicit `branches` arrays, the inner `Agent` component with its duplicate name/description/
inputs/outputs, and the `branching_mapping_key` data edge. What appeared: nothing — the wiring
those lines expressed is now implied by list order, by `{{triage.…}}` references, and by the
`switch`/`outcomes` targets.

---

## 4. Document reference

### 4.1 Top level

| Key | Required | Meaning |
|---|---|---|
| `weave` | yes | Format version, an integer. `1` until §9 says otherwise. |
| `name` | yes | The flow's name. Display and identity; same rules as step names (§4.2). |
| `description` | no | Prose. |
| `inputs` | no | Schema map (§4.6) of what a run must be given. Replaces `StartNode`. |
| `models` | no | Named model configs (§4.4). |
| `tools` | no | Named tool declarations (§4.5). |
| `agent` | one of | Sugar: the whole document is one agent step (§3.1). Mutually exclusive with `steps`. |
| `steps` | one of | Ordered list of steps (§4.2). |
| `outcomes` | no | Named terminal states and what each returns (§4.3). |
| `requires` | no | Map of plugin component type → semver range (§7). |
| `meta` | no | Opaque map. The only place unknown content is allowed to live. |

Unknown top-level keys are an error. Unknown keys anywhere are an error, except inside `meta` and
inside a `use:` component's own fields, which the owning plugin's schema judges (§7).

### 4.2 Steps

`steps` is an ordered list. Each step has a required `name` — lowercase `[a-z][a-z0-9_]*`, unique
across steps and outcomes (they share a namespace because branch targets resolve against both).
Control flow defaults to fall-through: each step runs after the previous one; the last step falls
through to the outcome `done`. A step may override with `then: <target>` where a target is a step
name or an outcome name. In v1 a `then` or `case` target must appear *later* in the list —
backward edges are reserved for loops (§11) and rejected by the validator.

Beyond `name` and `then`, a step declares exactly one **verb**:

**`agent:`** — a model with a tool loop.

```yaml
- name: triage
  agent:
    model: fast              # name from `models`, or an inline config
    prompt: "..."            # system prompt; templated
    tools: [runbook_lookup]  # names from `tools`; optional
    output:                  # optional: structured output schema (§4.6)
      status: string
      note: string
    transforms: [...]        # optional; see below
    max_tool_rounds: 10      # optional; default is the runtime's
```

Writes: `result` (string — the model's answer), unless `output` is declared, in which case the
runtime constrains the model to that JSON shape and writes exactly the declared keys. With
`transforms` present it also writes `transform_status` (and `transform_reason`,
`transform_name`, `transform_phase`), exactly as `packages/core/src/node/agent.ts` does today —
now namespaced under the step. Today's behavior of opportunistically merging JSON keys from the
answer is removed: structure is either declared and enforced or absent, never guessed.

**`llm:`** — a single completion, no tools. Replaces `LlmNode`.

```yaml
- name: summarize
  llm:
    model: fast
    prompt: 'Summarize these log lines: {{fetch.matches}}'
```

Writes: `text`.

**`tool:`** — a direct tool invocation. Replaces `ToolNode`.

```yaml
- name: fetch
  tool: log_search
  with:
    pattern: '{{inputs.alert}}'
    limit: 20
```

Writes: the tool's declared `outputs`, which for a tool step *are* contractual — the runtime
checks the executable's JSON against them and fails the step on mismatch, closing today's
"declared outputs are fiction" gap from the tool side.

**`switch:`** — branching. Replaces `BranchingNode`, `branching_mapping_key`, `DEFAULT_BRANCH`
and the first-string-in-state fallback.

```yaml
- name: route
  switch: '{{triage.transform_status}}'
  cases:
    rejected: handoff
    flaky: retry_note
  else: done
```

The switch expression is a single template reference, compared by string equality against `cases`
keys. `else` is required — there is no implicit default and no fallback scanning. Writes: nothing.

**`use:`** — a plugin-defined step. Replaces plugin `NodeUnion` members.

```yaml
- name: scrub
  use: RegexRewrite
  with:
    pattern: '\d{4}-\d{4}'
    replacement: 'XXXX'
    text: '{{triage.result}}'
```

`use` names a component type; the operator still decides which plugin code loads, exactly as
today. `with` is the component's config, validated by the plugin's registered schema (§7).
Writes: the outputs the plugin's manifest declares for that type.

### 4.3 Outcomes

`outcomes` is a map from outcome name to the payload the run returns when it ends there. Payload
values are templates. Replaces `EndNode` + `branch_name`.

```yaml
outcomes:
  done:
    note: '{{triage.result}}'
  handoff:
    note: '{{triage.result}}'
    reason: no-runbook        # literals are fine
```

If `outcomes` is omitted, the document gets an implicit outcome `done` whose payload is the
outputs of the last step that ran. A run's result is `{ outcome: <name>, outputs: <payload> }`.

### 4.4 Models

`models` maps a local name to a config. `provider` selects among builtins
(`openai`, `openai_compatible`, `ollama`, `vllm` — the set `packages/core/src/llm/provider.ts`
actually builds) or a plugin-registered provider type. This replaces the `OpenAiConfig` /
`OllamaConfig` / … component-type family with one shape discriminated by a field, so a new
provider is a new `provider` value, not a new union member.

```yaml
models:
  fast:
    provider: openai
    model: gpt-4o-mini
    api_key: $OPENAI_API_KEY   # $VAR strings resolve from the environment, as today
  local:
    provider: ollama
    model: qwen2.5:7b
    url: http://localhost:11434
    params: { temperature: 0 }  # generation parameters, passed through
```

Anywhere a model is expected (`agent.model`, `llm.model`, a transform's `model`), either a name
from `models` or an inline config object is accepted.

### 4.5 Tools

`tools` maps tool name to declaration. The name still matches an executable in `--tools-dir`
(filename minus extension), unchanged. `inputs` entries without a `default` are required, with a
`default` optional — the current convention, now stated by the format instead of implied.

### 4.6 Schemas

Everywhere the format wants a schema (`inputs`, tool `inputs`/`outputs`, agent `output`), it uses
one shape: a map from field name to either a bare type string or an object.

```yaml
inputs:
  alert: string                                # shorthand
  service:
    type: string
    description: The service the alert names.  # longhand
  limit:
    type: integer
    default: 5
```

Types are the JSON Schema primitive set: `string`, `integer`, `number`, `boolean`, plus `array`
(with `items`) and `object` (with `fields`, recursively this shape). This replaces `Property`
with its mandatory `title` and forbidden characters; the field name is the map key, so the
constraint "titles may not contain `.,{} \n'"`" becomes simply "field names are identifiers".

### 4.7 Templates

`{{ref}}` where `ref` is a dotted path: `inputs.<field>` for flow inputs, `<step>.<key>` for a
prior step's outputs. That's the whole language — no expressions, no filters, no bare names.
Literal `{{` is written `{{{{`. Every reference is resolved at validation time: the producer must
exist, the key must be one the producer actually writes (§4.2 defines each verb's written keys),
and the producer must precede the consumer on every control-flow path. Today's behavior — an
unresolvable placeholder stays in the prompt verbatim and fails at run time, a fictional data
edge delivers nothing silently — both become load-time errors.

---

## 5. Semantics

### 5.1 State

There is no shared state bag. Each step's outputs live under its name; a step receives exactly
the values its templates reference. Two steps writing an identically-named output cannot collide
because the step name qualifies everything. The reserved-key machinery
(`packages/core/src/session/reserved.ts`) shrinks to protecting the `inputs` namespace and
outcome names.

### 5.2 Control flow

The compiled graph is the same shape `packages/core/src/graph/` runs today — nodes and directed
edges — so the runner, session suspension and checkpointing carry over. What changes is that the
graph is *derived* (from list order, `then`, `cases`/`else`) instead of *transcribed* from edge
lists. Fan-out does not exist: a step has exactly one successor unless it is a `switch`, in which
case it has exactly the successors its cases name. The current footgun — several unconditional
edges out of one node, first-wins — is unrepresentable.

### 5.3 Validation

Four layers, all at load time, all before any process starts:

1. **Structure** — the published JSON Schema for the core format. Editors get this via
   `$schema`; the CLI embeds it. Strict: unknown keys fail outside `meta` and `use.with`.
2. **References** — names resolve (models, tools, step/outcome targets), the step/outcome
   namespace has no duplicates, every template reference names a real producer and a written key.
3. **Graph** — every step reachable, every path reaches an outcome, no backward edges (v1),
   producers precede consumers on all paths. Subsumes today's
   `packages/core/src/graph/validate.ts` checks with fewer cases, because the format cannot
   express most of the old failure modes (dangling edges, unrouted mappings, dead branches).
4. **Extensions** — each `use:` component and plugin provider/transform config is validated by
   the schema its plugin registered (§7); unresolvable component types fail here, as
   `packages/core/src/plugin/flow-preprocess.ts` does today.

`heddle validate` passing must mean the flow starts. Anything discoverable at load time that
today surfaces as a mid-run death (branch with no edge, placeholder never filled) is a validation
error under Weave. "Graph validation skipped" ceases to exist as an outcome.

### 5.4 Casing

The wire is snake_case (`api_key`, `max_tool_rounds`, `transform_status`). The TypeScript types
use the same names. `snakeToCamel` and its imports disappear.

---

## 6. What is deliberately absent

Each of these is absent because the runtime doesn't honor it, and goal 2 forbids unenforced
surface:

- `id` — names are identity. Nothing in the runtime keys on ids except deserialization plumbing.
- `metadata: {}` on every component — `meta` exists once, at the top level.
- Declared `outputs` on agent/llm steps — replaced by the verb's defined keys and the opt-in
  `output` schema, both enforced.
- `human_in_the_loop` — never implemented; interactivity is the bundle's `interactive` flag,
  an operator concern.
- `toolboxes`, datastores, MCP components, `Swarm`, `ManagerWorkers`, `A2AAgent` — never
  implemented.
- `ApiNode`, `CatchExceptionNode`, `FlowNode`, `InputMessageNode`, `MapNode`,
  `OutputMessageNode`, `ParallelFlowNode`, `ParallelMapNode` — refused by name today; simply
  inexpressible now. §11 says how their useful subset returns.
- Explicit `DataFlowEdge` / `ControlFlowEdge` lists — derived instead.
- Middleware, encoders, plugin module paths — unchanged policy, now with no schema surface to
  even attempt them.

---

## 7. Extensibility

The component-kind model from `docs/plugin-system-design.md` is unchanged: a spec names
component *types*; the operator names modules. What changes is how an extension type is
validated and versioned.

**Plugins register schemas, not deserializers.** A plugin manifest already declares its
components (`packages/core/src/plugin/manifest.ts`). Under Weave each spec-writable component
(step types for `use:`, transform types, provider types) carries a JSON Schema for its config in
the manifest. Validation layer 4 applies it. This deletes the entire deserializer seam:
`plugin/deserializer.ts`, `spec/open-unions.ts`, and the three vendor patches exist only because
the old format's validation was closed code instead of open data. There is no
`ComponentDeserializationPlugin` analogue because there is nothing to deserialize past — the
core schema is open where extensions plug in, and strict everywhere else.

**Specs can pin plugin versions.** Optional top-level `requires` maps component type to a semver
range, checked against the loaded plugin's declared version at validation layer 4:

```yaml
requires:
  SecretScrub: '^1.0'
```

This closes the "spec written against plugin 1.0, loaded against 9.0, no warning" gap
(`docs/plugin-system-design.md`). Absent an entry, any version passes, as today.

**Declared outputs for plugin steps are contractual.** The manifest declares what a step type
writes; the runtime checks the plugin's actual result against it, the same way tool steps are
checked. Template references into plugin-step outputs validate against the manifest declaration.

---

## 8. Relationship to bundles

Nothing about `.heddle` changes. `heddle.json`'s `flow` field points at a Weave file instead of
an Agent Spec file; the bundle `format` integer does not bump for this, per the versioning
argument already in `packages/core/src/bundle/format.ts` — readers open the flow through the
same input-format seam (`packages/core/src/spec/input-format.ts`) and the manifest's own shape
is untouched. `library/*/bundle.json` recipes are unaffected. The operator/document boundary the
bundle docblock states — sandbox policy, session bindings and discovery grants never travel —
is unchanged.

---

## 9. Versioning

`weave: 1` is an integer, not a semver — the same choice, for the same reasons, as the bundle
manifest's `format`. The rules:

- **Additive, enforced fields do not bump the version.** A new optional key that old readers
  would reject on strictness grounds *does* need care: strict validation means old CLIs fail
  loudly on new documents, which is the correct failure (an old runtime cannot honor what it
  cannot parse, and goal 2 forbids ignoring it).
- **`weave: 2` means a reader of 1 misreads it**, not merely fails on it. Expected never, held
  in reserve.
- The CLI states its supported version in `--version` output and error messages name both
  versions on mismatch.

This replaces `agentspec_version: 26.2.0` and the SDK's version table
(`vendor/agentspec/src/versioning.ts`) — a semver we neither minted nor enforced.

---

## 10. Migration

The write-path lock-in is almost nil: the only serializer in the repo is `heddle init`
(`packages/cli/src/scaffold/templates.ts`). The cost concentrates in the parse path and in
fourteen documents.

1. **`packages/core/src/spec/`** — new parser: YAML/JSON → core JSON Schema → reference/graph
   resolution → the existing compiled-graph shape. `parser.ts`, `adapter.ts`, `open-unions.ts`
   and `load.ts` are replaced; `graph/compile.ts` shrinks (edges are derived upstream);
   `graph/validate.ts` loses the cases the format can no longer express.
2. **`packages/core/src/plugin/`** — delete `deserializer.ts`; reduce `flow-preprocess.ts` to
   layer-4 dispatch; extend the manifest schema with per-component config schemas and outputs.
3. **`vendor/agentspec/`** — deleted, with its three patches, its tsup build, and the root
   `build:vendor` / `prepare` scripts. `Property` re-exports in `spec/types.ts` and
   `plugin/types.ts` are replaced by the §4.6 schema shape.
4. **`heddle migrate <old-spec>`** — a converter from Agent Spec documents to Weave, covering
   the constructs heddle actually ran (the six node types, the four builtin providers, the two
   builtin transforms). It exists for the transition and for external users' documents; it is
   not a compatibility layer, and `heddle run` does not accept old documents.
5. **Documents** — regenerate `library/*/spec.yaml` (2), `examples/*` (12), the
   `create-heddle-agent` skill template and its `SKILL.md` gotchas (most of which describe
   failure modes Weave makes unrepresentable), `heddle init`'s scaffold, and
   `website/content/docs/{flows,nodes}.mdx`.
6. **Server** — `packages/server/src/flow-source.ts` error strings and `validate.ts` follow the
   new parser; the wire protocol for runs is untouched.

`packages/broker` and the website's library pages are unaffected.

---

## 11. Reserved for later

Held out of v1 deliberately; the format has a place for each when the runtime earns it.

- **Loops.** Backward `then`/`case` targets, legal once the runner enforces a flow-level
  `limits: { max_hops: N }`. The validator's backward-edge rejection is the reservation.
- **Parallel fan-out.** A `all:` step verb containing named sub-steps whose outputs namespace
  under the parent. Replaces what `ParallelFlowNode` promised.
- **Map.** A `each:` verb over an array input. Replaces `MapNode`/`ParallelMapNode`.
- **Sub-flows.** A `flow:` verb naming another Weave file within the bundle. Replaces
  `FlowNode`. Needs a story for input/output binding across the boundary first.
- **Error edges.** `on_error: <target>` on any step. Replaces `CatchExceptionNode` without a
  node.

Each lands as an additive verb or key under the rules of §9 — no version bump, old CLIs fail
loudly and correctly on documents that use them.
