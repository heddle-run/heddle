# Plugin System: Design and Extension Roadmap

All paths are relative to the repository root. Every claim below was read out of the file it cites.
Line numbers are against the tree at the time of writing and rot with every commit; the files that
churn most — `plugin/types.ts`, `plugin/executor.ts`, `plugin/host.ts`, `plugin/protocol.ts`,
`plugin/transform.ts`, `runner/events.ts` — are therefore cited by **symbol** rather than by line,
which is the only anchor that survives a phase landing. That rule is enforced, not merely stated:
`plugin/__tests__/design-doc-citations.test.ts` fails on a `file:line` citation into any of them.

> **Status.** This document was written against the tree *before* Phase 0, and lands in the same
> commit as the work it describes. Phases 0, 1, 2, 3, 4, 6 and V tier 1 are done; §9 marks what
> remains inside each. Phase 6 landed at one seam of six, which is what its own entry advised. The
> surveys in §3 and the "today" snippets in §7 have been brought forward to match, so a passage in
> the present tense describes the tree as it now is. Phases 5, 7, 9 and V tier 2 are still proposals
> — and where a phase landed differently from what §7 proposed, the proposal has been replaced by
> what was built, not annotated alongside it.

---

## 1. Goal

**Every decision the engine makes on a flow's behalf should be replaceable or interceptable by
code heddle did not compile in, running in its own process, under the isolation the current
plugin path already provides.**

Concretely, "any part of the agent" means the list the engine currently hardcodes: which provider
answers a model call, what happens when a node throws, whether a tool call is allowed to proceed,
how a tool's result is serialized back into the conversation, how state merges between nodes, how
a prompt template renders, which tools exist at all, and what the run looks like on the wire. Today
none of these were reachable from a plugin — the plugin surface was three component kinds, two verbs
heddle calls (`execute`, `apply`) and one a plugin could call back (`runTool`). It is now six kinds,
seven verbs (`after` joined them in Phase 6, `callTool` in Phase 7, `chat` in Phase 5, `encode` and
`finishEncode` in Phase 9) and four reverse calls (`emitEvent` and `log` from Phase 3, `callModel`
from Phase 4). Of the list above, four have been reached: **what happens when a node throws**
(Phase 6), **which tools exist at all** (Phase 7), **which provider answers a model call** (Phase 5),
and **what the run looks like on the wire** (Phase 9). A plugin can both *call* a model and *be* the
thing that answers one — two different questions, settled in opposite directions: a plugin composing a
request never chooses the model, and a plugin answering one is chosen by the spec.

The six kinds now differ along one axis worth naming, because it decides everything else about a
kind: **who selects it.** A node, a transform and a provider are named by the *spec*. A middleware is
installed by the *operator*. An encoder is chosen by the *request*. That last one is new with Phase 9
and it is the only kind whose selector is neither of the two parties who were previously assumed to be
the only candidates — which is why it needed a namespace of its own (`protocol`) rather than reusing
the component-type namespace a document writes into.

What the goal does **not** mean:

- **Not in-process extension.** `packages/core/src/plugin/loader.ts` still exists and the CLI still
  uses it (`packages/cli/src/cli/run.ts:174`, `packages/cli/src/cli/validate.ts:26`), but the server
  offers exactly one path — `buildPlugins` only ever calls `loadRemotePlugin`
  (`packages/server/src/plugins.ts:29`), and the reason is written there at
  `packages/server/src/plugins.ts:9-18`. Nothing in this design walks that back. Widening the
  protocol is the *only* way forward that keeps that property.
- **Not code in specs.** `packages/core/src/plugin/loader.ts:5-7` states the rule: plugins are
  named by the operator, never inside a flow file, so sharing a spec can never cause code to be
  executed. Several proposals below are spec-*named* (a flow writes `component_type: RegexNode`),
  but a spec never names a *module*. The operator still decides which code is loaded; the spec only
  selects among what was loaded.
- **Not "every internal type becomes public API."** `State` is a concrete class that `NodeExecutor`
  is typed against (`packages/core/src/node/types.ts:7`), the sandbox deliberately stays inside the
  executor (`packages/core/src/sandbox/types.ts:1-8`), and neither is on the table. See §10.
- **Not an Agent Spec conformance goal.** Agent Spec has nothing to say about any of this — see §2.
  It does not follow that the SDK is immovable: `vendor/agentspec` is a local tree and §8.1 proposes
  extending it. The conformance that matters is the *format* — a heddle spec stays a valid Agent Spec
  document — not the current TypeScript SDK's export list.

---

## 2. What Agent Spec's plugin system actually is

### 2.1 The published scope, in the spec's own words

The how-to guide carries an admonition that settles it:

> The current plugin system enables the serialization and deserialization of custom components for
> Agent Spec. To fully support custom components, you also need to: 1. Support the feature in your
> Agent Spec runtime implementation. 2. Support the conversion between the custom Agent Spec plugin
> component and its corresponding implementation in your runtime implementation.
>
> — `oracle.github.io/agent-spec/26.1.2/howtoguides/howto_plugin.html` (verified HTTP 200)

The normative language spec says the same thing structurally, splitting the work across two
different pieces of software:

> For supporting reading, writing and executing plugin components, the serialization and
> deserialization logic must be added in an Agent Spec SDK and the execution logic of the plugin
> component must be added in an Agent Spec Runtime of choice.
>
> — `.../agentspec/language_spec_26_1_2.html`, "Ecosystem of plugins"

So: **an Agent Spec plugin teaches a deserializer how to read a `component_type`. It says nothing
about how to run it.** That second half — "the execution logic … must be added in an Agent Spec
Runtime of choice" — is heddle. `packages/core/src/plugin/types.ts`'s module docblock already says this in the
codebase's own voice, and it is correct.

### 2.2 The exact interfaces, from the vendored source

The vendored SDK is upstream at commit `f8b5b034…` plus the additive patch series recorded under
*Local modifications* in `vendor/agentspec/VENDOR.md`; every interface quoted below is upstream's,
unmodified. That is a starting condition, not a constraint — §8.1 proposes patching it, and every
limit described in §2.4 is a limit of *this commit* rather than of the format.

```ts
// vendor/agentspec/src/serialization/deserialization-plugin.ts:10-22
export interface ComponentDeserializationPlugin {
  readonly pluginName: string;
  readonly pluginVersion: string;
  supportedComponentTypes(): string[];
  deserialize(data: SerializedDict, context: DeserializationContext): ComponentBase;
}
```

```ts
// vendor/agentspec/src/serialization/serialization-plugin.ts:10-22
export interface ComponentSerializationPlugin {
  readonly pluginName: string;
  readonly pluginVersion: string;
  supportedComponentTypes(): string[];
  serialize(component: ComponentBase, context: SerializationContext): SerializedFields;
}
```

Four members each. There is no `execute`, no lifecycle, no `init`, no capability negotiation, no
manifest. That is the entire extension surface Agent Spec defines.

**Dispatch is by `component_type` string and nothing else.** The deserializer builds a
`Map<componentType, plugin>` from every plugin's `supportedComponentTypes()` and throws on collision
(`vendor/agentspec/src/serialization/deserialization-context.ts:56-59`), with the builtin plugin
appended last (`vendor/agentspec/src/serialization/deserializer.ts:40`). An unclaimed type is
`No plugin to deserialize component type "X"`
(`vendor/agentspec/src/serialization/deserialization-context.ts:174`).

**`component_plugin_name` / `component_plugin_version` are write-only provenance.** They are stamped
onto output only for non-builtin types:

```ts
// vendor/agentspec/src/serialization/serialization-context.ts:203-206
if (!isBuiltinComponentType(componentType)) {
  componentDump[keys.componentPluginName] = plugin.pluginName;
  componentDump[keys.componentPluginVersion] = plugin.pluginVersion;
}
```

Nothing reads them back. heddle's own deserializer treats them as envelope and drops them
(`packages/core/src/plugin/deserializer.ts:40-43`). **There is no plugin version enforcement
anywhere in the system** — loading a spec that records version `1.0` against a plugin at version
`9.0` produces no warning. If heddle wants version compatibility, heddle invents it.

The language spec's one structural rule is prose, not schema:

> if a plugin component is intended as a subtype of another component … it must then have the same
> unmodified attributes as the parent type and can only add new attributes.

Additive-only, enforced socially.

### 2.3 Where the docs and the vendored TS SDK diverge

| Claim | Published docs | Vendored TS SDK | Consequence for heddle |
|---|---|---|---|
| Language | Python-first throughout; `grep -ci typescript` over the language spec page returns **0** | `vendor/agentspec/` exists and is what heddle imports | The documented workflow is not the one heddle runs. Treat the docs as intent, the source as contract. |
| Base class vs interface | Two ABCs (`ComponentSerializationPlugin`, `ComponentDeserializationPlugin`) you subclass | Two structural `interface`s — nothing to extend, just satisfy the shape | heddle's `HeddleDeserializationPlugin` (`packages/core/src/plugin/deserializer.ts`) is a hand-written class, correctly. |
| The easy path | `PydanticComponentSerializationPlugin(component_types_and_models={...})` — a ~8-line, logic-free plugin | **No equivalent exists.** There is no zod-driven "give me a schema map" plugin. | Every heddle custom type needs a hand-written deserializer. That is what `packages/core/src/plugin/deserializer.ts` is — 207 lines re-declaring the SDK's protocol/dangerous/opaque field sets and hand-rolling the field walk. The SDK's `snakeToCamel` and `propertyFromJsonSchema` *are* exported from the root (`vendor/agentspec/src/index.ts:306` and `:30`) and are reused (`packages/core/src/plugin/deserializer.ts:10`, called at `:125` and `:66`/`:205`); what cannot be reused is the builtin plugin's own field-filtering logic — see the row below. |
| Reusing the builtin plugin | n/a | `BuiltinsComponentDeserializationPlugin` is exported from `vendor/agentspec/src/serialization/index.ts` but **not** from `vendor/agentspec/src/index.ts:300-312` | Cannot wrap or delegate to it. Hence the local re-declaration of `PROTOCOL_FIELDS` / `DANGEROUS_KEYS` / `OPAQUE_FIELDS` at `packages/core/src/plugin/deserializer.ts:35-59`. |
| Implementation types | n/a | `SerializedDict` / `SerializedFields` are used by the exported interfaces but are **not** exported (`vendor/agentspec/src/index.ts:300-312`) | `packages/core/src/plugin/deserializer.ts:17-20` recovers it with `Parameters<ComponentDeserializationPlugin['deserialize']>[0]`. Worth upstreaming. |
| Runtime binding | The how-to's execution snippet has the loader construction **commented out**, so `agentspec_loader` is undefined | n/a | The runtime side of Agent Spec plugins is the least-exercised part of the whole system. There is no prior art to copy. |

### 2.4 The closed-union problem

Every union in the SDK is a `z.discriminatedUnion("componentType", [...])` fixed at module load.
None is extensible from outside the package: the one registration function that exists
(`registerNodeUnionSchema`, `vendor/agentspec/src/flows/lazy-schemas.ts:28`) is exported from its own
module but not re-exported from `src/index.ts`, and the other four unions have no registration
function at all.

| Union | Definition | Members | Gates |
|---|---|---|---|
| `NodeUnion` | `vendor/agentspec/src/flows/nodes/index.ts:22-37` | 14 | `Flow.startNode`, `Flow.nodes`, and both edge endpoint types, via `LazyNodeRef` |
| `MessageTransformUnion` | `vendor/agentspec/src/transforms/message-transform.ts:75-78` | 2 | `Agent.transforms` (`vendor/agentspec/src/agents/agent.ts:22`) |
| `LlmConfigUnion` | `vendor/agentspec/src/llms/index.ts:12-18` | 5 | `Agent.llmConfig` (`agents/agent.ts:17`), `LlmNode.llmConfig`, both transforms' `llm` (`transforms/message-transform.ts:29,53`) |
| `ToolUnion` | `vendor/agentspec/src/tools/index.ts:12-18` | 5 | `Agent.tools` (`agents/agent.ts:19`), `ToolNode.tool` (`flows/nodes/tool-node.ts:11`), `AgentSpecializationParameters.additionalTools` (`agents/specialized-agent.ts:16`) |
| `SupportedDatastoresSchema` | `vendor/agentspec/src/transforms/message-transform.ts:16-20` | 3 | transform `datastore`; not exported from the package root |

There is no base `MessageTransformSchema` at all — both transforms extend `ComponentBaseSchema`
directly (`vendor/agentspec/src/transforms/message-transform.ts:27,50-51`). `NodeBaseSchema` and
`ToolBaseSchema` do exist, but exporting a base is useless when the *union* is what gates membership.

The cruel part: **the hook exists and is one `export` away from being usable.**

```ts
// vendor/agentspec/src/flows/lazy-schemas.ts:28-34
export function registerNodeUnionSchema(schema: z.ZodType): void { _nodeUnionSchema = schema; }
export function registerFlowSchema(schema: z.ZodType): void { _flowSchema = schema; }
```

Both are exported from that module and used internally (`flows/nodes/index.ts:19,39`;
`flows/flow.ts:9,19`), but `vendor/agentspec/src/index.ts` does not re-export them, and
`vendor/agentspec/package.json` declares only `"exports": { "." : {...} }` — no subpath, so there is
no deep-import escape hatch either. `grep -rn register vendor/agentspec/src` returns exactly these
two definitions and their call sites. There is no `registerComponentType`, no `registerSchema`, no
mutable registry: `ComponentRegistry` is two frozen-by-convention object literals
(`vendor/agentspec/src/component-registry.ts:133,204`) with three read-only accessors
(`:270,277,282`) and no mutator anywhere in the file.

So the barrier for `NodeUnion` is the package's export surface, not the absence of a mechanism —
which is why §8.1 can buy it back for two lines. The other four unions have no mechanism either, and
cost more.

### 2.5 Why heddle needs its own runtime layer

Given the above, the split heddle already implements is the only one available:

| Concern | Owner | Where |
|---|---|---|
| Read a custom `component_type` into an object | Agent Spec plugin | `packages/core/src/plugin/deserializer.ts` |
| Make a `Flow` containing one pass zod validation | heddle workaround | `packages/core/src/plugin/flow-preprocess.ts` |
| Decide what kind of thing it is | heddle | `packages/core/src/plugin/registry.ts:20,127` |
| Run it | heddle | `packages/core/src/plugin/executor.ts`, `packages/core/src/plugin/transform.ts` |
| Confine it | heddle | `packages/core/src/plugin/host.ts` |
| Everything in §7 | heddle | does not exist yet |

Nothing in this document has an upstream analogue to conform to. That is freeing and it is also a
warning: there is no external pressure keeping the design honest, so the constraints have to be
self-imposed.

---

## 3. Where heddle is today

### 3.1 The three kinds

`kind` is the only switch, declared at `packages/core/src/plugin/manifest.ts:31` and validated at
`:123-128`; dispatched at `packages/core/src/plugin/remote-loader.ts:121-133`; grouped identically
for the in-process path at `packages/core/src/plugin/registry.ts:55-59`.

| `kind` | Author writes | Manifest supplies | RPC | Engine wiring |
|---|---|---|---|---|
| `node` | `createExecutor(node, deps) -> { execute(input, ctx) }` (`plugin/types.ts`, `PluginNodeDef`) | `inputs`, `outputs`, `branches`, `schema` (`manifest.ts:32-48`) | `execute` (`plugin/remote.ts`, `remoteNodeDef`) | `graph/compile.ts:77-80` → `PluginNodeAdapter` (`plugin/executor.ts`, `PluginNodeAdapter`), result becomes the node's output `State` (`plugin/executor.ts`'s `runNode`) |
| `transform` | `createTransform(component, deps) -> { apply(messages, ctx) }` (`plugin/types.ts`, `PluginTransformDef`) | `phase`, `schema` (`manifest.ts:48-50`) | `apply` (`plugin/remote.ts`, `remoteTransformDef`) | `TransformChain` (`plugin/transform.ts`, `TransformChain` / `apply`) around the model call at `node/agent.ts:125` (pre) and `:158-162` (post) |
| `component` | `validate?(component)` only (`plugin/types.ts`, `PluginComponentDef`) | `schema` | **none** | **none** |

**`kind: 'component'` does nothing at runtime.** `remoteComponentDef` returns `{ componentType }`
plus at most a `validate` (`plugin/remote.ts`, `remoteComponentDef`). `nodeDef` and `transformDef` both return
`undefined` unless the kind matches (`plugin/registry.ts`, `nodeDef` / `transformDef`), so a `component` is unreachable
from `graph/compile.ts:77` and from `plugin/transform.ts`, `TransformChain.build`. `flow-preprocess.ts:128-130` leaves it
in the document with no stand-in, on the stated grounds that it is "deserialized with their parent".

That is the whole contract, and it is narrower than it looks: a `component` survives *only* because
its parent node or transform was replaced by a stand-in and therefore removed from the document the
SDK validates. Put one in a builtin slot — `Agent.tools`, `Agent.llmConfig` — and the closed union
rejects it before any plugin code runs. Nothing documents that constraint, and there is no test for
`kind: 'component'` end to end.

> Two of those three sentences have since stopped being true, and the section is kept as the
> baseline the redesign was argued against rather than rewritten. The stand-in machinery is gone
> (Phase V), so a `component` survives because the widened unions admit it in place; and
> `Agent.llmConfig` is no longer a closed slot (Phase 5), which is what a `provider` is written
> into. `Agent.tools` is still closed — `ToolUnion` was deliberately left alone, see §7.7.

### 3.2 The RPC verbs

```ts
// packages/core/src/plugin/protocol.ts — as landed
export interface HostMethods          { execute: ExecuteParams; apply: ApplyParams }
export interface HostLifecycleMethods { init: InitParams; shutdown: ShutdownParams; cancel: CancelParams }
export interface PluginMethods        { runTool: RunToolParams; emitEvent: EmitEventParams; log: LogParams }
```

`ExecuteParams` carries `{ componentType, node, input, workspace?, workspaceUnavailable? }`;
`ApplyParams` carries `{ componentType, component, phase, messages }`. Every reverse call carries the
id of the `execute` or `apply` it was made inside (`InFlight`), so `RunToolParams` carries
`{ call, name, input }`, `EmitEventParams` `{ call, name, data? }` and `LogParams`
`{ call, level, message }`. That id is what selects the reporter and the tool scope heddle built for
the call, which is why a plugin cannot choose the namespace its events are published under or the
sandbox session its tools run in.

`workspace` is a pushed value rather than a verb, and the argument is written out on the field: it is
a constant for the whole call and heddle knows it before it dispatches, so a verb would spend a round
trip, a capability grant and a `PluginMethods` entry on a string it already had — and it would make
`getWorkspace` asynchronous out of process and synchronous in it, so the same plugin logic could not
be written once. It is absent, with `workspaceUnavailable: 'confined'` in its place, when the plugin's
own process is sandboxed: the node's tool scope is a different session, so the path would be one the
plugin cannot open.

Framing is JSON Lines with direction decided by shape — a message with a `method` is a request, one
with a `partial` is progress on a call that has not finished (`isPartial`), and anything else is a
response.

Two verb sets rather than one, and the split is enforcement rather than taxonomy: every lifecycle
verb is paired with machinery — `init`'s version check, `cancel`'s grace timer, `shutdown`'s SIGKILL —
that a caller reaching it through `PluginHost.call` would bypass while appearing to have used it. See
§7.1.

Still deliberately absent, and the absence is still load-bearing: no `getManifest` (the manifest is
data), no `validate`/`inferInputs`/`inferOutputs`/`branches` (manifest-served, `plugin/remote.ts`), no
notification form, no model access, no credential request.

**These types are enforcement, not documentation** — which took two phases. Phase 0 typed
`PluginHost.call<M extends HostMethod>(method: M, params: HostMethods[M])`, where it had been
`method: string` and
a typo compiled. That left the frames with no caller: Phase 2's lifecycle verbs are built by
`hostRequest(id, verb, params)`, so the params of a frame nobody calls are still checked against the
verb. `HostVerbs` is the union of the two maps and is what that function is generic over.

### 3.3 The manifest

The rationale is at `packages/core/src/plugin/manifest.ts:1-19` and it is the design's best idea:
every question the parser and compiler need answered is answered *as data*, so only `execute` and
`apply` cross the boundary. Two properties fall out — `parseFlow` stays synchronous, and a spec's
shape can be inspected without running the author's code. `/v1/validate` depends on the second one.

The cost is that a manifest cannot compute. `inferInputs`, `inferOutputs`, `branches` and `phase`
all take the component in the in-process API (`plugin/types.ts`, `PluginTransformDef` / `PluginNodeDef`); the remote adapter
collapses them to constants (`plugin/remote.ts`'s `remoteNodeDef` / `remoteTransformDef` tails). Anything whose shape depends on its own
configuration is not expressible out of process — including the shipped guardrails plugin, whose
`phase` is read from a spec field (`examples/guardrails/plugin.js:136`).

`manifest.command` (`manifest.ts:62`, resolved at `remote-loader.ts:90-98`) is one of two routes to
a non-JavaScript plugin — the other being an executable entry point with a shebang, invoked by path
(`defaultCommand`, `remote-loader.ts:56-74`), which is the form the loader prefers under `--safe`
(`remote-loader.ts:41-55`). `manifest.command` is needed only when the entry point cannot be made a
self-contained executable — the `python3 plugin.py` case named at `sandbox/types.ts:64-67`. Both
routes are the justification for JSON Lines (`plugin/protocol.ts`, module docblock). Both are now covered — a shell
plugin invoked by path and the same one started through `manifest.command`, in
`plugin/__tests__/remote.test.ts`'s "a plugin that is not a JavaScript module" — where before, the
only tests of `loadRemotePlugin` wrote a non-executable `.mjs` and exercised the
`[process.execPath, entry]` branch alone.

### 3.4 The placeholder-substitution workaround

`packages/core/src/plugin/flow-preprocess.ts:1-21` explains it. Deserialize each custom component on
its own (where the SDK's plugin path does work), hand the SDK an inert builtin stand-in carrying the
same `id` and `name`, let the SDK check every invariant it normally would, then swap the real
components back by id.

| | Node | Transform |
|---|---|---|
| Stand-in type | `InputMessageNode` (`flow-preprocess.ts:32`) | `MessageSummarizationTransform` (`:39`) |
| Synthesized fields | `component_type, id, name, inputs, outputs` (`:109-115`) | `component_type, id, name, llm` (`:120-125`), with `llm` a fake `OllamaConfig` (`:41-46`) |
| Restore | `spec/adapter.ts:166-169`, one lookup by id | `spec/adapter.ts:131-160`, rebuilds the frozen `Agent` |
| Identity key | `${componentType}:${name}` (`:165`) so an inlined component resolves to one id | same |

Covered: `Flow.nodes` and `Agent.transforms`. Not covered: `Agent.tools`, `Agent.llmConfig`, the
`Agent` itself, `Swarm` members, `Flow.inputs`/`outputs`. `metadata`, `config`, `data`, `headers`,
`queryParams` are opaque and never walked (`:49,142`), so a component buried in one is invisible —
neither swapped nor reported.

The walk is also where an unrecognised `component_type` is caught (`:130-137`), which is why every
document takes this path whether or not plugins are configured (`spec/parser.ts:24-31`).

One real defect fell out of this, and Phase 0 fixed it. `parseAgent`, the `Agent` branch of
`parseComponent`, and both `parseComponent*` functions discarded `substitution.pluginTransforms`,
so they returned the synthetic `MessageSummarizationTransform` pointing at the fake Ollama config.
`loadComponent` (`spec/load.ts:32-40`) goes through that path, and it is what
`heddle validate <spec>` uses (`packages/cli/src/cli/validate.ts:29`). The plugin's own `validate()`
still ran, so it was never a soundness hole — but the object was wrong, and any future
standalone-Agent execution path would have silently run zero transforms. The restore now happens in
`spec/parser.ts`'s `toComponent`/`restoreAgentTransforms`, covered by
`spec/__tests__/parser.test.ts`.

### 3.5 The security model

The whole model is the process boundary, argued at `plugin/host.ts`, module docblock.

| Control | Where | Note |
|---|---|---|
| Chosen, not inherited, environment | `PluginHost.resolveCommand` → `env: launch.env`, defaulted on `PluginHostOptions.env` | The server passes literally `env: {}` — `packages/server/src/plugins.ts`, with the reasoning in the comment above it |
| Lazy start | `loadRemotePlugin` reads only the manifest; the process starts inside `PluginHost.call` | Parsing and validating a flow executes zero lines of the author's code |
| Optional sandbox | `host.ts`'s `resolveCommand`; wired at `server/plugins.ts` | Covered by "spawning a plugin under a sandbox" in `plugin/__tests__/remote.test.ts`, against a stub `SandboxSession` — the whole `SandboxCommand` crosses, not just its argv |
| Per-run registry | `server/runs.ts:157`, disposed in `finally` at `:175` | Plus `rmSync` of the run's mkdtemp dir (`server/request-code.ts:239-240`) |
| Teardown that cannot be declined | `dispose` → `stopProcess` (`host.ts`) | `shutdown` then a closed stdin, then SIGKILL. The kill is armed *before* either is sent and only the process actually ending disarms it, so a plugin that ignores both dies as it always did, `SHUTDOWN_GRACE` later |
| Source is never imported | `server/request-code.ts:277-280` | Written `0500` with an absolute `#!node` shebang; the interpreter is absolute because the plugin's env has no `PATH` |
| No `$VAR` deref in submitted specs | `server/runs.ts` → `provider.ts:32-53` | See §7.3 |
| Bounded stderr | `host.ts`'s `STDERR_LIMIT`, applied in the `stderr` handler in `start` | A logging loop cannot grow the server's heap |
| Only declared verbs are served, and only granted ones answered | `plugin/protocol.ts`'s `SERVED` / `PLUGIN_METHODS`; `host.ts`, `serve()` | Two stages, kept separate on purpose: "heddle does not serve X. It serves: …", then "X is not granted to this plugin". A missing runner is a third message, about heddle's own wiring. The served set and the granted set are now different: heddle serves `runTool`, `emitEvent`, `log`, and the server grants all three to a submitted plugin (`packages/server/src/plugins.ts`'s `GRANTED`), with its own reasoning about a plugin pushing bytes down its caller's stream written above that constant |

Two stale comments contradicted this and have been fixed: `packages/server/src/validate.ts` claimed
"loading a plugin executes it, both at import and again at compile", which is false on the only
path the server takes, and the broker's container-per-run rationale
(`packages/broker/src/container.ts`) rested on the same stale premise. The broker's conclusion
survived the correction but its reason changed — instances are still not reused, now because
submitted *tool scripts* run unsandboxed on that platform.

### 3.6 Extension points, summarized

| Extension point | Exists? | Spec-named? | Runs out of process? | Evidence |
|---|---|---|---|---|
| Custom node | yes | yes | yes | `graph/compile.ts:77-80` |
| Custom transform | yes | yes | yes | `plugin/transform.ts`, `TransformChain.build` |
| Custom sub-component | nominal | only under a plugin parent | n/a — never executed | `plugin/remote.ts`, `remoteComponentDef` |
| Custom tool *type* | no | — | — | `ToolUnion` closed; `registry.claim` forbids builtin names (`plugin/registry.ts:77-83`) |
| Custom LLM provider | yes — Phase 5 | yes, as an `llm_config` | yes, verb `chat`, streaming optional | `llm/provider.ts`, `providerFor`; `plugin/remote.ts`, `remoteProviderDef` |
| Custom tool source / registry | no | — | — | `Registry` is an interface (`tool/types.ts`, `Registry`) with no plugin route |
| Custom wire protocol / encoder | no | — | — | `serializeEvent` (`packages/server/src/sse.ts`, `serializeEvent`) is a free function with one hardcoded rendering |
| Any interception | no | — | — | §5 |

---

## 4. The ceiling

Suppose you add `kind: 'provider'` to `manifest.ts:31` and let it through the validator at `:123-128`.
What happens next:

1. `remote-loader.ts:121-133` has a three-arm switch with nowhere to put it. Add a fourth arm — it
   pushes into… what? `HeddlePlugin` has exactly `components`, `nodes`, `transforms`
   (`plugin/types.ts`, `HeddlePlugin`).
2. Add `providers?: PluginProviderDef[]`. Now `PluginRegistry.add` (`registry.ts:55-59`) groups it
   and `kindOf` reports it. Fine so far.
3. `flow-preprocess.ts:107-127` has no arm for it, so the component has no stand-in and
   `LlmConfigUnion` rejects the document (`vendor/agentspec/src/llms/index.ts:12-18`). Add a third
   placeholder — see §8.
4. Now the component parses. `createProvider` is a free function imported directly at
   `node/agent.ts:17` and `node/llm.ts:5`; it gates on a module-level `Set`
   (`llm/provider.ts:10-15,122`) and returns `new OpenAIProvider(opts)` unconditionally (`:141`).
   Nothing consults a registry. Add the lookup.
5. Now the plugin is asked for a provider. **`HostMethod` is `'execute' | 'apply'`
   (`plugin/protocol.ts`, `HostMethods`).** There is no verb that means "answer a chat completion".
   Add one.

Steps 1–4 are plumbing. Step 5 is the ceiling: **a new manifest kind expands what a plugin can *be*;
it does nothing about what a plugin can *do* while running.** Those are two independent axes, and the
protocol only widens on one of them at a time.

| Axis | Type | Today | What widening buys |
|---|---|---|---|
| What a plugin can **be** | `HostMethod` — heddle calls the plugin | `execute`, `apply`, `after` | New kinds. Each new kind needs a verb, a dispatch arm, an engine call site, and (usually) a placeholder. **Phase 6's `middleware` is the exception that shows what the placeholder is for**: it cost a verb, a dispatch arm and a call site, and no placeholder at all — because no document names one, so nothing has to survive the SDK's closed unions. |
| What a plugin can **do** | `PluginMethod` — the plugin calls heddle | `runTool`, `emitEvent`, `log`, `callModel` | New *abilities* for kinds that already exist. A node that can `callModel` is a new class of node with no new kind, no placeholder, and no SDK involvement — which is exactly how Phase 4 landed. |

The second axis is dramatically cheaper and is now at four methods. What a plugin still **cannot** do
is read run-scoped state, and that is all that is left of this ceiling. The rest landed: emitting,
logging and the workspace handle in Phase 3, and thinking in Phase 4. `PluginServices`
(`plugin/types.ts`, `PluginServices`) is `{ signal, runTool, callModel, emitEvent, log }` and is
shared by both context types, with `PluginContext` adding `node` and `getWorkspace` on top of it —
built at `plugin/executor.ts`'s `runNode` for a node and at `plugin/transform.ts`'s `apply` for a
transform. So a plugin can compute, run a tool, ask a model, report on itself, and write a file its
tools can read. The prediction in the row above held exactly: `callModel` cost one entry in
`PluginMethods`, one arm in `serve`, and no manifest kind, no placeholder and no SDK change at all.

There is a second-order trap here, and it has been narrowed three times rather than removed.
`PluginHost.setToolRunner` (`plugin/host.ts`, `setToolRunner`) is first-writer-wins and is called
from both `createExecutor` and `createTransform` (`plugin/remote.ts`). Phase 0 added the second call:
before it, a transform's `runTool` worked or failed depending on whether an unrelated plugin node
happened to run first, which made **capability depend on graph structure** and would have made any
capability model meaningless.

Phase 3 narrowed it again, for a different reason. A node's `runTool` no longer goes through that
host-wide runner at all: `PluginHost.call` takes the node's own scoped runner and `serveRunTool`
looks it up from the `call` id the frame names, so a node's tools run in the tool scope whose
workspace the node was handed. What was left on `setToolRunner` was the fallback for a transform,
which owns no scope, and for a hand-rolled plugin that sends no `call`.

Phase 4 took the transform off that list too: a transform now passes its own runner through
`CallOptions.runTool` like a node does, built by `toolRunner` (`plugin/services.ts`) — the same one
its in-process twin gets. So the host-wide runner serves exactly one case now, a plugin hand-rolling
the protocol without a `call` id, and `setToolRunner`'s first-writer-wins is no longer load-bearing
for anything heddle itself emits. It still justifies itself on every executor in one compile sharing
the same registry, which is true today and false the moment per-node registries or per-node policy
exist — but the blast radius of that assumption is now one legacy shape rather than every transform.

`callModel` was built to have no equivalent. `Pending.modelCaller` has no host-wide fallback at all,
because a model config belongs to a component and "whichever one heddle happens to have" would be a
request sent somewhere the flow's author did not ask for.

---

## 5. The structural gap: components vs. middleware

All three current kinds are **spec-named slots**: a flow author writes a `component_type` into a
document, and heddle instantiates something there. That works because those positions are named in
the spec — `Flow.nodes` is a list, `Agent.transforms` is a list.

Most of the agent is not a slot.

Slots and interception are the two shapes this section contrasts, and they cover everything the
engine does *during* a run. They do not cover what the run looks like from outside it — that is a
third shape, developed in §7.9.

### 5.1 The runner's dispatch is a bare await

```ts
// packages/core/src/runner/runner.ts:60-73
let output: State;
try {
  output = await current.executor.execute(signal, nodeInput);
} catch (err) {
  const execErr = err instanceof Error ? err : new Error(String(err));
  this.emit({ type: 'node_error', nodeName: current.name, nodeType: current.type, error: execErr });
  throw execErr;
}
```

There is no position in the spec that means "around every node". You cannot name that slot; you can
only intercept it. Everything blocked by this one un-wrappable await: per-node retry, per-node
timeout (the only timeout is whole-run, `runner.ts:17`), node-result caching, dry-run substitution,
approval gates, checkpointing.

And line 72 was unconditional: **every node error was fatal, and heddle had no error-handling
extension point of any kind.** `EventHandler` returns `void` (`runner/events.ts`, `EventHandler`), so
the emit beside the throw could not influence it, and `grep -rn 'retry\|backoff' packages/core/src`
found nothing. A transient 429 from a tool ended the run.

**Phase 6 opened exactly this one.** The catch clause is now the `nodeError` seam: the chain is
consulted, and a middleware can retry the node, substitute a result, fail with a different reason, or
let the error stand (§7.4). The rest of this section is unchanged and still true — there is still no
position in the spec that means "around every node", which is why the answer was interception rather
than a slot, and per-node timeout, memoization, dry-run and approval gates are still blocked on the
`node` seam that Phase 6 declared and did not wire.

### 5.2 The agent loop fuses eight policies into one function

`AgentExecutor.runAgent` (`node/agent.ts:86-254`) is a single 169-line method containing, in order:

| Policy | Line | Currently |
|---|---|---|
| Round cap | `agent.ts:21,134` | Module const `MAX_TOOL_ROUNDS = 10`; not a `RunnerOption`, not a spec field, not per-agent |
| Message construction | `:114-121` | system + history + one user turn that is `JSON.stringify(inputData)` |
| Chat history ingress | `:105,112` | Magic `_chat_history` state key, produced only by `packages/cli/src/chat/ui.tsx` |
| Termination | `:155` | "no `tool_calls`" only. `finish_reason` is captured (`llm/openai.ts:41`, and again in `collectStream`) and read nowhere — a `length`-truncated answer is silently accepted as final |
| Tool dispatch | `:190` | Serial `for…of`, no concurrency, no per-call policy |
| Tool result serialization | `:214` | `JSON.stringify`, no truncation or summarization |
| Tool error feedback | `:242-246` | `content: \`Error: ${err}\`` — no retry, no structure |
| Output shaping | `:168-175` | `{ result: content }` then `Object.assign(outputData, JSON.parse(content))` if it parses — a model answering the literal text `{"result":"no"}` overwrites the key just set |

None of these is a spec-named position. A plugin cannot occupy "the place where a tool result is
serialized." It can only wrap the call.

The double parse this section originally named here — `tc.arguments` read leniently for the event
payload and again strictly inside `executeTool`, so a malformed blob left the observer's record
disagreeing with what executed — **landed as fixed in Phase 0**. There is now one reading,
`parseToolArguments`, called at `agent.ts:194` and used by both. It is still worth knowing about,
because the constraint it was named for survives the fix: a `toolCall` hook must receive that one
authoritative parse (`agent.ts:195`), and anything that reintroduces a second reading breaks the hook
rather than just the log.

### 5.3 Provider construction is not even injectable

`Provider` (`llm/types.ts:98-122`) is a one-required-method interface — the cheapest possible seam.
Phase 2 added a second, *optional* method (`chatCompletionStream?`), which strengthens the argument
rather than weakening it: the interface absorbed a whole new transport without a breaking change and
without a second implementation existing yet. But `createProvider` is a free function imported
directly (`node/agent.ts:17`, `node/llm.ts:5`), and `Dependencies` (`node/types.ts:12-49`) has no
provider or factory field. **Even a library embedder who controls `Dependencies` cannot substitute or
wrap provider construction without patching source.** Retry, caching, rate limiting, token
accounting, record/replay for CI — all unreachable.

### 5.4 heddle already has one working middleware

`TransformChain.apply` (`plugin/transform.ts`, `TransformChain.apply`) returns `pass | modify | reject`
(`plugin/types.ts`, `TransformResult`) and that return value genuinely changes control flow: a `pre` rejection
skips the model call entirely (`node/agent.ts:125-128`), which is why the playground can demo
guardrails with no credential.

So the mechanism is proven in this codebase. Its limitation is the **number of taps**: exactly two,
both outside the tool loop (`agent.ts:125`, `:158`). A transform never sees a tool call, a tool
result, a tool error, or a round boundary. **Adding taps to a proven mechanism is a smaller change
than inventing one**, and the verdict vocabulary should stay recognisably the same.

That is what Phase 6 did, and the prediction held on both counts. `MiddlewareChain.consult`
(`plugin/middleware.ts`) is the same three lines of logic as `TransformChain.apply` — entries in
order, a verdict each, the first non-neutral one wins — and `AfterVerdict` is `TransformResult`'s
shape with the verbs the new call site can honour. The third tap is `runner.ts`'s catch clause; five
more are named in `SEAMS` and unwired.

---

## 6. Seam inventory

Difficulty: **S** = the interface already exists, one call site; **M** = one function to restructure,
a handful of call sites; **L** = touches the protocol, the event system, or the SDK.

| # | Seam | Location | What an author wants | Shape | Diff |
|---|---|---|---|---|---|
| 1 | Provider selection | `llm/provider.ts:10-15,122,141` | Anthropic/Bedrock provider; record-replay provider for free deterministic CI | component | S |
| 2 | Provider wrapping | `llm/provider.ts:141`; no `Dependencies` field (`node/types.ts:12-49`) | retry+backoff, response cache, rate limit, audit log, PII redaction | middleware | S |
| 3 | Node dispatch | `runner/runner.ts:61-62` | per-node timeout, memoization, dry-run, approval gate | middleware | M |
| 4 | Node error | `runner/runner.ts:63-73` | ~~retry, degrade to a canned answer~~ **landed, Phase 6** — the `nodeError` seam. Routing to a *fallback node* did not: a middleware supplies a result, never a route | middleware | S |
| 5 | Tool call | `node/agent.ts:190-249` | deny, rewrite args, return cached result — this is `humanInTheLoop` | middleware | M |
| 6 | Tool result | `node/agent.ts:214` | truncate/summarize a 2 MB blob before it eats the context window | middleware | S |
| 7 | Tool error | `node/agent.ts:242-246` | retry a 429 instead of narrating it to the model | middleware | S |
| 8 | Agent termination | `node/agent.ts:155`; `finish_reason` unread (`llm/openai.ts:41`, and in `collectStream`) | stop on truncation; stop when a `submit_answer` tool is called | middleware | S |
| 9 | Output shaping | `node/agent.ts:168-175` | enforce declared `outputs` as a schema; repair non-conforming answers | middleware | S |
| 10 | Round cap | `node/agent.ts:21` | a research agent needing 40 rounds; partial results instead of `:251` throwing | config, not a plugin | S |
| 11 | Tool registry | `tool/types.ts`, `Registry`; only `FileRegistry` | MCP discovery, HTTP tool catalogue, inline spec tools | component | S |
| 12 | Tool executor / protocol | `tool/executor.ts:6,137,151,173` | wrap an existing CLI (argv in, exit code out) without a JSON shim | component | M |
| 13 | Tool discovery metadata | `tool/registry.ts:35,46,52-56` | descriptions and schemas from the tool itself, not duplicated in the spec | component | S |
| 14 | Tool JSON Schema | `buildToolSchema` (`node/agent.ts:527-551`), `:542` | optional parameters — today every input is `required` | middleware | S |
| 15 | Message construction | `node/agent.ts:114-121`; `Message.content: string` (`llm/types.ts:10`) | few-shot exemplars, templated user turn, prompt-cache markers, multimodal | middleware | M |
| 16 | Chat history store | `node/agent.ts:105,112` | server-side threads in Redis/Postgres; sliding window | component | S |
| 17 | State merge | `state/state.ts:36-38`, applied `runner.ts:89` | namespace by node, append, or error on collision instead of silent clobber | component | S |
| 18 | Input resolution | `runner/runner.ts:107-126` | strict mode: a node sees only its declared `inputs`; fail loudly on a missing source | middleware | S |
| 19 | Flow termination | `runner/runner.ts:84-87`; `branchName` unread (`spec/types.ts:88`) | a plugin `AbortNode`; reporting *which* exit a multi-exit flow took | capability flag | S |
| 20 | Template engine | `substituteTemplate` (`node/agent.ts:498-504`); `getString` (`state/state.ts:27-30`) | dotted paths, loops, rendering objects instead of blanking them | component | S |
| 21 | Branch matcher | `node/branching.ts:6,25,28-34,42-48` | numeric ranges, regex, LLM-decided routing. Also fixes the order-dependent fallback at `:28-34` | component | S |
| 22 | Graph rewrite | `graph/compile.ts:70` | wrap every `AgentNode` in a guardrail; insert checkpoints. The generic escape hatch | middleware | M |
| 23 | Graph validation | `graph/validate.ts:5-56` | org policy rules; warnings that don't block | component | S |
| 24 | Event emission | `runner/events.ts`, `EventHandler`, 9 emit sites | any two-way hook at all — a plugin that *observes* or intercepts the engine's events (Phase 6). ~~`EventType` is closed so a plugin cannot even emit~~ **emission landed, Phase 3**: `EventType = BuiltinEventType \| PluginEventType` (`runner/events.ts`), `pluginReporter` (`plugin/executor.ts`), the `emitEvent`/`log` verbs (`plugin/protocol.ts`'s `PluginMethods`, served in `plugin/host.ts`'s `serve`) | protocol | M |
| 25 | Plugin context | `plugin/types.ts`, `PluginServices`; built at `plugin/executor.ts`'s `runNode` and `plugin/transform.ts`'s `apply` | ~~`emitEvent`, workspace handle~~ **landed, Phase 3**; ~~`callModel`~~ **landed, Phase 4**, on both context types. Still wanted: run-scoped state | protocol | S |
| 26 | Generation params | ~~`spec/types.ts:24` unread~~ **landed, Phase 4**: `generationParams` (`llm/provider.ts`) reads `defaultGenerationParameters` into `ChatRequest` (`llm/types.ts`), read by `AgentExecutor` and `LLMExecutor` | temperature, maxTokens, topP, JSON mode. Still absent: seed, stop | data widening | S |
| 27 | Streaming | ~~absent from `Provider`~~ **landed, Phase 2**: `chatCompletionStream?` (`llm/types.ts`), `llm/openai.ts`, `token_delta` (`runner/events.ts`) | token-by-token rendering | protocol | L |
| 28 | Sandbox backend | `sandbox/index.ts:7,50-68` | Docker/gVisor for the playground; a recording no-op for CI | component | S |
| 29 | Sandbox policy | global at startup (`server/runs.ts:74-77`) | "fetch needs network, file-writer must not" — unexpressible | middleware | M |
| 30 | Spec format / source | `spec/parser.ts:21,71`; `spec/load.ts:13-15,22` | TOML, a DSL; load from a URL or a git ref | component | S |
| 31 | Builtin override | `plugin/registry.ts:77-83`; skip list `plugin/transform.ts`, `BUILTIN_TRANSFORMS` | ship a real `MessageSummarizationTransform`; "AgentNode with retries" | precedence rule | M |
| 32 | Placeholder slots | `plugin/flow-preprocess.ts:32,39,107,118` | **the ceiling on every "component" row above** | vendored SDK | M |
| 33 | Wire protocol / event encoding | `serializeEvent` (`packages/server/src/sse.ts`, `serializeEvent`), `SseStream.send` | render a run as AG-UI, OpenAI-compatible chunks, or OTLP spans instead of heddle's own frames | encoder | S |

### Ranked shortlist

1. **#4 node error** (`runner.ts:63-73`) — largest capability gap in the engine (heddle cannot
   recover from *any* failure), smallest diff, and it is the cleanest place to prove the middleware
   verdict vocabulary.
2. ~~**#25 plugin context**~~ **done.** The reporting and workspace half landed in Phase 3, and
   `callModel` in Phase 4 — so LLM-as-judge nodes, semantic routers and summarizers are writable
   today, and none of them ships an SDK or holds a credential.
3. **#1+#2 providers** (`llm/provider.ts`, `createProvider`) — best leverage/cost ratio in the
   codebase; the interface is already one method. #26 was its precondition and landed with Phase 4,
   so a provider plugin now receives a request worth differing on.
4. **#5 tool call** (`agent.ts:190-249`) — this is the mechanism `Agent.humanInTheLoop`
   (`spec/types.ts:46`) promises and nothing implements. Grep confirms the field is read nowhere.
5. **#11 tool registry** (`tool/types.ts`, `Registry`) — two methods, and the demand is already proven:
   the server had to write `mergeRegistries` *outside* core (`packages/server/src/tools.ts:15-29`)
   because no composition existed inside.
6. **#6+#7 tool result / error** (`agent.ts:214,242-246`) — result-size management is the most common
   production agent problem and today there is no answer at all.
7. **#3 node dispatch** (`runner.ts:61-62`) — the generic seam; do it after #4 has settled the shape.
8. **#32 SDK unions** — `vendor/agentspec` is ours to patch (§8), so this is an early cheap track
   rather than a parallel hope. Unblocks every remaining "component" row.
9. **#33 encoder** (`serializeEvent`) — the only kind with *no* placeholder cost and *no* capability
   surface, because it is never named in a spec (§7.9). Deferred here only because AG-UI, its
   motivating consumer, wants #27 to be worth having.

---

## 7. Proposed design

### 7.1 The widened `HostMethod` set

```ts
// packages/core/src/plugin/protocol.ts — lifecycle as landed (Phase 2); the rest proposed

export const PROTOCOL_VERSION = 1;

/** Work verbs. `PluginHost.call` is generic over this map. */
export interface HostMethods {
  // ---- existing ------------------------------------------------------------
  execute: ExecuteParams;       // kind: node
  apply: ApplyParams;           // kind: transform
  // ---- new kinds -----------------------------------------------------------
  chat: ChatParams;             // kind: provider
  listTools: ListToolsParams;   // kind: registry
  // ---- middleware ----------------------------------------------------------
  before: BeforeParams;         // middleware, pre-seam
  after: AfterParams;           // middleware, post-seam
}

/** Lifecycle verbs. Sent by the host on its own behalf; unreachable through `call`. */
export interface HostLifecycleMethods {
  init: InitParams;             // sent once, immediately after spawn
  shutdown: ShutdownParams;     // sent once, before SIGKILL, with a grace period
  cancel: CancelParams;         // sent when the host has stopped waiting for a call
}

export interface HostVerbs extends HostMethods, HostLifecycleMethods {}
export type HostVerb = keyof HostVerbs;

export interface InitParams extends Record<string, unknown> {
  protocol: number;
  /** Capabilities the host actually granted. May be a subset of what was asked. */
  capabilities: PluginCapability[];
  /** Seams this plugin's middleware was registered on, in composition order. Phase 6. */
  seams?: Seam[];
}

export interface InitResult {
  protocol: number;
}

export interface CancelParams extends Record<string, unknown> {
  /** The id of the call the host has given up on. */
  call: number | string;
}

/** `shutdown` carries nothing: the verb is the whole message. */
export type ShutdownParams = Record<string, never>;

export interface ChatParams extends Record<string, unknown> {
  componentType: string;
  /** The custom LlmConfig component's own spec fields. */
  config: Record<string, unknown>;
  request: WireChatRequest;
}

export interface ListToolsParams extends Record<string, unknown> {
  componentType: string;
  component: Record<string, unknown>;
}

export interface BeforeParams<S extends Seam = Seam> extends Record<string, unknown> {
  seam: S;
  /**
   * Fresh per seam invocation — including each re-invocation caused by a `retry`
   * verdict, which is a new invocation like any other. It pairs a `before` with
   * its own `after` and guarantees nothing beyond that; it is not an identity a
   * middleware can accumulate across attempts. Use `attempt` for that (§7.4).
   */
  callId: string;
  subject: SeamSubject[S];
  /** The operator's configuration for this middleware, validated at load (§7.4). */
  component: Record<string, unknown>;
}

export interface AfterParams<S extends Seam = Seam> extends Record<string, unknown> {
  seam: S;
  callId: string;
  subject: SeamSubject[S];
  component: Record<string, unknown>;
  outcome: { ok: true; value: unknown } | { ok: false; error: WireError };
  /**
   * 1-based attempt number and the host's ceiling, present only on seams where
   * `retry` is permitted. The host already owns the retry loop and therefore
   * already knows the count; middleware must not reconstruct it (§7.4).
   */
  attempt?: number;
  maxAttempts?: number;
}
```

The lifecycle half of that block is what shipped; it is not what this section originally proposed.
**Four things the implementation decided differently from the earlier draft, all in Phase 2**, kept
here because the reasoning is what Phases 3–9 will be read against:

1. **Lifecycle verbs are not `HostMethod`s.** The draft put `init` and `shutdown` in one union with
   `execute` and `chat`. They landed in a separate map, because each is paired with machinery a caller reaching
   it through `call()` would bypass while appearing to have used it — `init`'s version check,
   `cancel`'s grace timer, `shutdown`'s SIGKILL. `HostVerbs` is the union of the two maps, and
   `hostRequest(id, verb, params)` builds the frames `call` does not, so no verb reaches the wire with
   its params unchecked.
2. **The field is `protocol`, not `protocolVersion`.** In a message named `init` carrying nothing else
   versioned, the suffix said nothing the key did not.
3. **`InitResult.pluginVersion` is gone.** The draft called it advisory and said the host neither
   enforces nor records it, which is a description of a field with no reader. A plugin that wants to
   announce its version has stderr and the manifest.
4. **Silence means version 1**, and this is the compatibility rule the draft never wrote down. A
   plugin predating the handshake answers `init` with "unknown method", or with a result carrying no
   `protocol` at all. Both are read as 1 (`spokenProtocol`), because version 1 *is* the protocol as it
   stood before `init` existed. Refusing them would have made the handshake the compatibility break it
   was added to prevent. When `PROTOCOL_VERSION` moves past 1 that same silence becomes a mismatch,
   which is the point. **Compatible means equal** — there is no range to express, so there is no
   semver.

`init` does not undo the lazy-start property. `PluginHost.start()` is already deferred to the first
`call`; `init` is simply the first frame written after spawn, so a plugin that never runs is still
never started. It is also not *waited* for: blocking the first call on the answer would charge every
plugin a round trip for a check that fails that call anyway, and would report a plugin whose handler
never returns as "did not answer init", sending its author to the handshake instead of the handler.

Adding a frame *type* is the one genuinely delicate change. Direction is decided by shape —
"has `method`" means request — and a streaming partial has an `id` but no `method`, so `settle` would
eat it: `{ id, partial }` has neither `result` nor `error`, so the call would resolve with `undefined`
and the caller would be told the plugin returned nothing. That needs a third discriminator, and it
landed as:

```ts
export interface RpcPartial { id: number | string; partial: unknown; }
export type RpcMessage = RpcRequest | RpcResponse | RpcPartial;

export function isPartial(message: RpcMessage): message is RpcPartial {
  return typeof (message as RpcRequest).method !== 'string' && Object.hasOwn(message, 'partial');
}
```

Tested against the presence of `partial` and the absence of `method` rather than by calling
`isRequest`, so the three shapes stay disjoint however `receive` happens to order its tests. `receive`
routes partials to a handler that **resets the pending timer without deleting the entry** — the
timeout is a silence budget, not a total budget, and measured from the request it would kill a plugin
that has been answering all along and report it as one that never answered.

**`partial` is `unknown`, and stays that way.** The payload is per-verb: a `chat` partial (§7.6) is a
`ChatChunk`. Typing the frame against any one verb would make the others liars. What the frame owes
the host is routing, and routing needs only the `id`.

**A partial is not `emitEvent` in another envelope, and the line between them is settled** — Phase 3,
argued at `RpcPartial` in `plugin/protocol.ts`. A partial is *a piece of one call's answer*: it is
delivered to the `onPartial` that `PluginHost.call`'s own caller passed and to nothing else, so what
it means is decided by that call site rather than by the plugin. An `emitEvent` event is *a report
about the run*: published on the run's stream, reaching every client watching it, namespaced so it
cannot be mistaken for one of heddle's own, and outliving the call that made it. A partial also
cannot be a `PluginCapability`, because it is a frame with no request to refuse and no response to be
refused on — which is the deciding argument for `emitEvent` being a verb rather than a shape of
partial: a malformed event name has to come back as an error, and a frame with no id to answer can
only be dropped.

Both reset the timeout of the call they name, so no author ever has to pick a frame in order to stay
alive. And the emitted runtime deliberately offers a plugin author **no way to send a partial**
(`plugin/runtime-source.ts`, module docblock), because nothing in heddle passes an `onPartial` for a
plugin's `execute` or `apply` — a frame whose only consumer would be `undefined` is not a progress
channel. **Middleware progress in Phase 6 is therefore `emitEvent`, not a partial channel.**

### 7.2 The widened `PluginMethod` set — **mostly landed, Phases 3 and 4**

This is the cheap axis, and the one that changes what people can build. `emitEvent`, `log` and
`callModel` landed; only `getState` is still a proposal. `getWorkspace` landed as something other
than a verb, which is recorded below the table.

```ts
export type PluginMethod =
  | 'runTool'      // exists
  | 'emitEvent'    // landed, Phase 3
  | 'log'          // landed, Phase 3
  | 'callModel'    // landed, Phase 4
  | 'getState'     // read the run's accumulated State
  | 'callPlugin';  // deliberately NOT proposed — see Open questions
```

| Method | Rationale | Serving code |
|---|---|---|
| `callModel` | **Landed.** The single highest-value addition. Without it, an LLM-as-judge node, a semantic router or a summarizer must ship its own SDK *and* obtain its own credential — and a submitted plugin has an empty environment (`PluginHost.resolveCommand`), so it cannot. | `PluginModel` (`plugin/services.ts`), bound per execution and served in `plugin/host.ts`'s `serveCallModel` against the caller the call was dispatched with — per component, and with no host-wide fallback at all. See below for why. |
| `emitEvent` | **Landed.** A plugin node was silent between `node_start` and `node_complete` (`runner.ts:47,77`). Required opening `EventType` (`runner/events.ts`) to a namespaced string plus a `data?: unknown` payload, which is what `PluginEventType` is. | `pluginReporter` (`plugin/executor.ts`), served in `plugin/host.ts`'s `serveEmitEvent` against the reporter the call was dispatched with. |
| `log` | **Landed.** `console.log` is silently redirected to stderr (the generated runtime's `console` shim, `plugin/runtime-source.ts`) and stderr is bounded to 4096 bytes and only surfaced on failure (`host.ts`'s `STDERR_LIMIT`). There was no way for a working plugin to say anything. | Same reporter as `emitEvent`, published as `plugin_log` carrying `level` and `message`. |
| `getState` | `execute` receives only the node's resolved input (`plugin/remote.ts`, `remoteNodeDef`), which after `resolveInputs` is *usually* the whole state (`runner.ts:112-114`) but is not guaranteed to be. Explicit beats incidental. | Requires the Runner to hand `currentState` to `Dependencies` per node — a real change, and the weakest item on this list. |

Note what is *not* here: no `readFile`, no `fetch`, no `getEnv`. The process boundary denies those,
and re-granting them over RPC would hand back exactly what `plugin/host.ts`, module docblock bought.

**Values pushed with the request, which are not verbs.** `getWorkspace` was on this list and does not
belong on it. What a node's tool-scope workspace answers is: a plugin that runs two tools cannot
otherwise find the file the first one wrote, and under `--safe` a path it invented with `mkdtemp` is
not there on the tool's side at all. It ships as `ExecuteParams.workspace` (`plugin/protocol.ts`),
read by `PluginContext.getWorkspace` (`plugin/types.ts`), **with no capability and no entry in
`PluginMethods`.**

The argument for pushing it, written out on the field: the value is a constant for the whole call and
heddle knows it before it dispatches, so a verb would spend a round trip, a capability grant and a
`PluginMethods` entry on a string it already had — and it would make `getWorkspace` asynchronous out
of process and synchronous in it, so the same plugin logic could not be written once. The price is
that heddle `mkdtemp`s for every remote node execution including the ones that never open it, where
in process the same call is deferred until a plugin asks; and that this is the one asymmetry between
the two paths. `reporting.test.ts` pins the rule as "needs no capability, because it is not a call
into heddle".

That also keeps §7.3's invariant intact: `PluginCapability = PluginMethod` is what makes the grantable
set derivable rather than maintained, and it holds only while every member is a verb.

**Which model a `callModel` reaches — the one decision Phase 4 had to get right.** This draft assumed
the plugin would be handed the *run's* provider. It is handed the **component's**: `PluginModel`
(`plugin/services.ts`) reads the `llm_config` on the plugin's own component in the spec — the same
field an `Agent` and an `LlmNode` carry, deserialized by the same SDK path, camelCased into
`llmConfig` with no extra plumbing. Four things follow, and the fourth is why the alternatives lose:

- **A submitted document is readable as a statement of where a run sends things.** A plugin that
  named its own endpoint would make that unknowable, which is the property `provider.ts`'s
  `applyDefaultCredential` exists to protect and would have been undone from a direction it cannot
  see.
- **There is no fallback, deliberately.** A component with no `llm_config` fails at the call naming
  the field. Borrowing the operator's default endpoint would let a plugin spend a credential nothing
  in the flow asked it to spend.
- **`createProvider` is the one door.** A plugin's call is built by the same function an agent's is,
  with the same `allowEnvRefs`/`defaultKey`/`defaultUrl` from `Dependencies` — so `$VAR` refusal
  under `--allow-request-code` and the operator-credential rule apply to it unchanged, rather than
  being restated somewhere they could drift.
- **"The run's provider" is not a thing that exists.** A flow has zero or many agents with different
  configs, and one plugin process serves every component of that plugin — a judge node and a
  summarizer transform, on two different models. That is why `Pending.modelCaller` has no host-wide
  fallback where `Pending.toolRunner` does: a tool registry is one thing for the whole flow, so a
  scopeless runner is a worse answer but *an* answer. There is no host-wide model that would be
  merely worse.

**Buffered, never streamed.** `Provider.chatCompletionStream` exists and `completeChat` would use it.
It is not used here because heddle cannot tell a plugin's model call from its scratch work — the
judge in §7.8(b) asks for `{"score":…}`, parses it and returns a number — so publishing those tokens
would put a plugin's private reasoning into the same `token_delta` a client renders as the run's
answer. A plugin that wants to be watched has `emitEvent`, which is namespaced and cannot be mistaken
for one of heddle's own. This is the same argument as the `post`-transform veto in `completeChat`,
reached from the other side.

**The clock had to change with it.** A per-call timeout is a *silence* budget, and a plugin blocked
on `callModel` is not silent — it is waiting on heddle, which knows exactly how long it has kept it
waiting. Without a hold, the server's 30-second `--plugin-call-timeout` is really a 30-second ceiling
on *heddle's own* model call, and a 45-second answer kills a plugin that did nothing wrong while
reporting that it never answered. `Pending.serving` (`plugin/host.ts`) suspends the timer for exactly
as long as heddle is inside a reverse call, nests, and is released in a `finally`. `runTool` takes
one too: it had the same latent hazard and only ever paid it against slow tools.

**Manifest declaration.**

```json
{
  "name": "reviewer",
  "version": "2.1.0",
  "capabilities": ["runTool", "callModel", "emitEvent"],
  "components": [{ "componentType": "LlmJudge", "kind": "node" }]
}
```

Validated in `validateManifest` (`packages/core/src/plugin/manifest.ts`, `validateManifest`) against a closed set,
same treatment as `kind` at `:123-128`: an unknown capability is a load-time error naming the
plugin, not a runtime surprise.

**Grant/deny at load.** The manifest *requests*; the host *grants*.

```ts
// packages/core/src/plugin/remote-loader.ts — proposed addition to RemotePluginOptions
export interface RemotePluginOptions {
  timeout?: number;
  session?: SandboxSession;
  env?: Record<string, string>;
  /**
   * Capabilities this plugin may use. A manifest that asks for one not listed
   * here fails to load, naming the capability — the operator's policy is not
   * something a submitted plugin gets to discover by probing at runtime.
   */
  capabilities?: PluginCapability[];
}
```

**Enforcement** replaced the hardcoded `request.method !== 'runTool'` check. This draft proposed a
single `granted.has()` in its place; the implementation kept two stages instead, and that is the
better decision:

```ts
// packages/core/src/plugin/host.ts — serve(), as landed
if (!isPluginMethod(request.method)) {
  respond({ error: { name: 'PluginError',
    message: `heddle does not serve "${request.method}". It serves: ${PLUGIN_METHODS.join(', ')}.` } });
  return;
}

if (!this.granted.has(request.method)) {
  respond({ error: { name: 'PluginError',
    message: `"${request.method}" is not granted to this plugin. Add it to "capabilities" ...` } });
  return;
}
```

Collapsing the two would merge "this heddle is too old to do that" with "your operator did not
allow that", and a plugin built against a newer heddle has no other way to tell them apart. The
first stage also makes the `switch` below it exhaustive against `PluginMethod`, so a capability
added without a handler fails to compile rather than leaving its caller waiting for a reply. Both
messages are asserted in `plugin/__tests__/remote.test.ts`'s capabilities block.

**Why this must precede the protocol widening.** `packages/core/src/llm/provider.ts:92-113` closed a
specific hole, and its own comment states it precisely:

```ts
// packages/core/src/llm/provider.ts:103-109
if (config.url) {
  throw new LLMError(
    `this llm_config sets "url" but no "api_key". The server's own credential ` +
      `is only used with its own endpoint, so a flow that chooses where to send ` +
      `requests has to supply the key for them.`,
  );
}
```

The operator's key is attached only when the spec brought no credential *and* named no URL
(`provider.ts:98-112`), because otherwise `llm_config: { url: https://attacker.example }` with no
`api_key` would have the operator's key posted to that host.

Now add `callModel` with no gate. The plugin never sees the key — the host holds it — but it
**spends** it, on a provider built with `defaultKey` at `provider.ts`'s `applyDefaultCredential`. The
same argument applied to `runTool`, which is why the gate in `serve()` was load-bearing and had to
survive being generalized — it started life as an accidental side effect of only one method existing,
and is now the deliberate two-stage check above.

This draft said the exposure was that a plugin's calls are *invisible*. Phase 4 sharpened that and
the sharper version is the one that stands. Because a `callModel` goes to the component's own
`llm_config` (§7.2), the endpoint and the model **are** in the submitted document. What is not in it
is the **volume**: `execute` is opaque by construction (`plugin/remote.ts`, `remoteNodeDef`), so a
plugin is free to make a thousand calls inside one node while the flow shows one, and nothing in the
engine bounds that — `MAX_TOOL_ROUNDS` bounds an agent's loop and has no equivalent here.

**As landed.** `callModel` is withheld from submitted plugins whenever `--default-llm-key` is set
(`grantedBy` in `packages/server/src/plugins.ts`), and the refusal carries the operator's own
sentence rather than core's generic one: `RemotePluginOptions.refusedBecause` lets the server explain
a policy core has no business knowing about, and `checkGrant` appends it only for the capabilities
actually refused. Without that, a plugin author whose manifest is correct is told to go and fix their
manifest — the same failure mode `provider.ts`'s "a caller whose flow suddenly ran unauthenticated
would have no idea why" was written against.

The coarseness is deliberate and worth stating as a loss: on a server with a default key — which is
what the playground is — an LLM-judge plugin cannot be submitted at all, not even one bringing its
own `api_key`. A per-component check would have to be right about every path `createProvider` can
take to the operator's key; this one is right by not having the key in play. Covered in
`packages/server/src/__tests__/plugin-capabilities.test.ts`.

**The transform inconsistency was fixed in the same change.** `remoteTransformDef.createTransform`
took one parameter and dropped the `deps` the interface declares (`plugin/types.ts`), so a
transform's `runTool` failed for want of a runner — *unless* the same plugin also provided a node
that had already run, in which case `setToolRunner`'s first-writer-wins had installed one and it
worked. Capability that depends on unrelated graph structure is not a capability model. It now
installs its own runner, covered by "runs a tool on the transform behalf" in
`plugin/__tests__/remote.test.ts`.

### 7.4 The `middleware` kind — **landed, Phase 6, at one seam**

`nodeError` is wired; the other five are declared and refused. What follows describes the shape as
built, with the draft's proposals corrected where the implementation went a different way.

**Seams are a table, not an enum.** The draft proposed a closed union of names. What landed is
`plugin/seams.ts`, a `Record<Seam, SeamDef>` carrying, per seam, its call-site position, which halves
it has, whether its subscribers join always or only on failure, which verdicts each half admits, and
whether heddle consults it yet. The reason is that three separate things have to agree about a seam
and none can be trusted to remember: the manifest validator refuses a subscription heddle will never
honour, `readAfterVerdict` refuses a verdict the call site cannot obey, and `init` tells the plugin
both before it is mid-run. All three read one table.

Listing the five unimplemented seams is the point rather than a courtesy. A manifest naming
`toolCall` today is refused with *"which heddle does not consult yet"* instead of loading into a
silence its author reads as a broken middleware. And the table is where `retry`'s absence at
`toolCall` is written down — not as a limitation to be discovered, but as a property of that call
site: by the time a tool call fails, the assistant message requesting it is already in `messages`, so
there is no clean state to re-enter. At `node` there is, because `runner.ts` writes `nodeOutputs` and
merges state only *after* the `try`.

**`nodeError` is not a hook shape of its own.** It is the node position's `after` chain filtered to
failures — `{ position: 'node', hooks: ['after'], when: 'error' }`. Nothing precedes an error, so it
has no `before`; when the `node` seam lands it joins the same reverse-registration chain and nothing
written today changes meaning. One `after` verb serves every seam, because a chain is one thing: one
order, one short-circuit, one handler table. A verb per seam would have made that ordering a property
of which verb heddle happened to send.

**Verdicts as landed**, checked against the seam rather than the union:

```ts
export type AfterVerdict =
  | { action: 'pass' }                                  // neutral; the chain continues
  | { action: 'replace'; value: Record<string, unknown> }
  | { action: 'retry'; delayMs?: number }
  | { action: 'fail'; reason: string };
```

`fail` requires a non-empty `reason`, because it replaces the only diagnosis anybody had.

**The retry ceiling is heddle's, and it is defence in depth rather than the bound.** `retry` is a
`continue` in the runner's existing `for`, so a retried node **spends an iteration** — which makes
`maxIterations` the real bound on how many times anything executes, and the run timeout the bound on
how long. `RunnerOptions.maxNodeAttempts` (default 3, `--max-node-attempts`) adds only that the limit
is reported *at the node*, naming the middleware, rather than at the graph as "exceeded max
iterations" — a message that sends whoever reads it to inspect a graph that is fine. The iteration
message now says how many of them were retries, for the same reason.

At the ceiling the chain is **still consulted** and only `retry` is refused: a policy whose last
resort is a canned answer has to get that last chance. A refused retry is a warning and never a
`MiddlewareError`, which would blame a plugin for heddle's ceiling.

**The ceiling is handed *into* the chain, not applied to what comes out of it**, and the difference
is the whole of whether two plugins compose. `MiddlewareChain.consult` returns at the first entry
answering anything but `pass`. So a ceiling applied to the result reads "retry" from the retry policy,
turns it into `pass`, and the fallback behind it — installed for exactly this attempt, with a canned
answer ready — is never asked, because the consult was already over. Handed in as `allowRetry`, the
refusal lands on the one entry that asked and the chain carries on. A retry policy and a fallback are
the natural two-plugin arrangement and the first thing anyone will install; the version that broke it
passed its own test, which used a single middleware inspecting `ctx.attempt` itself.

**A replaced node routes on the unbranched edge**, and this is the subtlest thing in the phase.
`executor.branch()` reads state the executor wrote on its last *successful* run and never resets —
`PluginNodeAdapter._branch` and `SwitchNode`'s both — so consulting it after a failure returns the
branch from a previous visit, and a substituted node inside a loop would follow an edge that has
nothing to do with this visit. It is also the honest answer: a middleware supplies a result, never a
route, because `graph/validate.ts` checked reachability before anything ran.

**Open question 3 is answered: fatal, on every seam, with no opt-out.** A middleware that throws,
dies, times out or answers with nonsense fails the run as a `MiddlewareError` naming the plugin, the
component type and the seam.

The draft called the tempting split — fatal for `reject`-capable seams, skipped for observe-only —
undermined because failing open is a *security* failure for a guardrail and a *reliability* failure
for everything else. Read again, both halves say failing open is wrong; what the objection actually
shows is that the split has no survivable side. And the observe-only category it presumes does not
exist here: every middleware returns a verdict, and a verdict is authority. A component that only
wants to watch has `emitEvent` and `log`, which return nothing to anybody and cannot fail a run. The
only way to populate that category would be to let the plugin declare its own failure survivable, and
a policy the untrusted party opts out of is not a policy.

Fatal is also the only *observable* answer — a skipped guardrail yields a successful run and a
warning nobody reads, on a component no flow mentions, which is invisible by construction — and it is
the rule every other kind already runs under: a transform that throws fails the run, and so does a
plugin node.

**The reporting carries both failures, and this draft had it backwards.** It said the run should fail
with the original node error and attach the middleware's as `cause` — "the run dies either way and the
diagnosis the operator needs is the node's". That reasoning defeats the paragraph above it: burying a
dead middleware inside a `cause` is the same silence the skipped policy was rejected for. But
reporting the middleware's error *alone* is no better, because the flow's author did not install the
middleware and may not know it exists, and the node failed first. So the `MiddlewareError` is the
run's error, and its message carries the node's failure and a sentence saying a middleware is the
operator's and is removed the way it was loaded. The node's error is the `cause`.

One consequence lands outside core. `MiddlewareError extends PluginError`, and the server maps
`PluginError` to **400** on the reasoning that every plugin it loads arrived with the request — true
of every kind except this one, which is refused with a 400 if a caller submits it. A middleware
failure is therefore a 500: charging it to the caller would tell the one person who cannot fix it
that it is theirs to fix.

The kill switch already exists and needs no design: middleware is host-configured, so unloading it is
the same flag that loaded it, and no flow changes.

**What the draft proposed and did not land.** `BeforeVerdict`, `modify` and `reject` are unbuilt —
nothing subscribes to a `before` yet, and shipping a verdict vocabulary with no call site would have
been a contract nobody could test. The seam names and admitted actions are reserved in `SEAMS` so
that when `node` arrives the shape is already fixed.

---

The draft's own text follows, kept because the ordering and composition rules landed verbatim.

**Seams.** A closed enum, because each name is a real call site with a real contract:

```ts
export type Seam =
  | 'node'        // around runner.ts:61-62
  | 'nodeError'   // runner.ts:63-73
  | 'modelCall'   // agent.ts:122-126 and llm.ts:42-45
  | 'toolCall'    // agent.ts:181-182
  | 'toolResult'  // agent.ts:183
  | 'agentRound'; // agent.ts:121
```

**Why not `around(input, next)`.** Classic onion middleware needs the plugin to hold the
continuation and call back to proceed. The channel is already bidirectional and would support it
(`PluginHost.serve`, `plugin/host.ts`, `serve`, serves plugin-initiated requests), but it means a run's control flow is
suspended inside another process, and a plugin that returns without calling `next` hangs the run
until the call timeout fires (`plugin/host.ts`, `call`). Instead: a `before`/`after` pair that returns a
verdict — the same shape `TransformResult` already has (`plugin/types.ts`, `TransformResult`), which is the
precedent and the reason authors will recognise it.

```ts
export type BeforeVerdict<T> =
  | { action: 'proceed' }
  | { action: 'modify'; subject: unknown }   // change the input, then proceed
  | { action: 'replace'; value: T }          // skip the real call, use this
  | { action: 'reject'; reason: string };    // fail the call

export type AfterVerdict<T> =
  | { action: 'pass' }
  | { action: 'replace'; value: T }
  | { action: 'retry'; delayMs?: number }    // only where the host can retry
  | { action: 'fail'; reason: string };
```

`retry` is what makes seam #4 useful: `nodeError` is the one seam whose `after` runs on the failure
path, and `{ action: 'retry' }` is the whole feature.

**Ordering and composition.** Registration order is load order — `PluginRegistry.add` pushes in the
order plugins were passed (`plugin/registry.ts:47,55-65`), and `buildPlugins` iterates
`code.plugins` in submission order (`packages/server/src/plugins.ts:27`).

- `before` is evaluated in registration order; `after` is evaluated in **reverse** registration
  order — the onion, even without `next`.
- **Authority is by evaluation order, not by registration position.** In either phase, the first
  middleware *evaluated in that phase* that returns a non-neutral verdict wins and short-circuits the
  remainder of that phase, and the host emits a `warning` naming the winner. In `after` that is the
  last-registered middleware, which is the point of the onion. This mirrors `TransformChain.apply`
  stopping at the first rejection (`plugin/transform.ts`, `TransformChain.apply`).
- **Which verdicts are neutral.** In `before`, `proceed` is neutral and `modify` continues the chain
  (see the next bullet); `replace` and `reject` short-circuit. In `after`, `pass` is neutral;
  `replace`, `retry` **and** `fail` all short-circuit. Extending the short-circuit to every
  `AfterVerdict` is deliberate: it makes retry-vs-`fail` and retry-vs-retry conflicts unreachable by
  construction, so the design owes no ranking between them. Collect-then-rank would be the
  alternative, and it would need a justification for why `after` ranks while `before` short-circuits.
- **Two middlewares both modifying**: modifications compose. Each sees the previous one's output,
  exactly as `TransformChain.apply` does (`plugin/transform.ts`, `current = result.messages`).
- **Pairing invariant.** `after` runs for exactly the set of middlewares whose `before` ran, in
  reverse of that set — never for one whose `before` was skipped. A short-circuiting `before` counts
  as having run, so the winner's own `after` still runs, on the value the winner supplied. Nothing
  observes a `before` without its `after`, or the reverse.
- **A three-middleware trace** (A, B, C in registration order). Full pass: `before` A → B → C, the
  real call, `after` C → B → A. Short-circuit: `before` A returns `proceed`, `before` B returns
  `replace`, C's `before` is skipped, the real call is skipped, and the `after` phase runs B → A on
  B's value. C is never consulted in either phase.
- **`retry` re-enters from the top.** A `retry` verdict re-invokes the seam as a new invocation: a
  fresh `callId`, the full `before` chain again, and `attempt` incremented. It does not resume the
  underlying call in place, because at `runner.ts:61` there is nothing to resume. The host enforces
  its own attempt ceiling and stops honouring `retry` past it, so a miscounting or malicious
  middleware cannot loop a run indefinitely; the manifest's `maxAttempts` cap (§7.8a,
  `"maximum": 10`) is author-declared config and guarantees nothing on its own.
- A middleware may **not** introduce a branch. `graph/validate.ts:26-51` checks reachability before
  anything executes, and `PluginNodeAdapter` already enforces declared branches for the same reason
  (`plugin/executor.ts`'s `runNode` branch check). A `replace` verdict on `node` supplies a `State`, never a route.

**Manifest.** Seams are declared, not discovered, so `parseFlow` still learns everything from data:

```json
{
  "componentType": "RetryPolicy",
  "kind": "middleware",
  "seams": ["nodeError"],
  "schema": { "type": "object", "properties": { "maxAttempts": { "type": "integer" } } }
}
```

**Spec-named or host-configured?** Middleware is **host-configured**: the operator loads it, it is
not written into the flow. That preserves `plugin/loader.ts:5-7` and it is the honest answer for
something that runs on every node whether the flow asked or not. A middleware that a flow *does*
select is just a transform, which already exists.

**Then the operator must have somewhere to put the configuration.** For a spec-named kind,
`ctx.component` is the component's own spec fields, straight out of the document. A host-configured
middleware has no document, so `schema` above would describe something nothing can produce and
`ctx.component.maxAttempts` would read `undefined`. The configuration channel is therefore part of
this kind, not a follow-up:

The draft put that channel on the loader's options, as `RemotePluginOptions.componentConfig`,
validated at load against the manifest's `schema`. **It landed in one place instead, and the reason
is worth recording, because the draft's version was built first and was wrong in a way a green test
suite could not see.**

Configuration arrives at `MiddlewareChain.build` — that is where `--plugin-config` lands, and the
only object a middleware is ever constructed from. A `componentConfig` on the loader was therefore a
*second* channel: it was validated and then dropped, while the one that delivered was checked against
nothing. Each half was tested on its own — one test asserted that a bad `componentConfig` fails to
load, another asserted that `ctx.component` carries what `build` was given — so neither test ever
asked one object to do both, and the gap survived.

```ts
// packages/core/src/plugin/types.ts — PluginMiddlewareDef
  /** Check the operator's configuration before anything is built from it. */
  validateConfig?(config: Record<string, unknown>): void;
```

The check travels on the def and runs where the configuration arrives. `remoteMiddlewareDef` fills it
in from the manifest's `schema`; an in-process middleware may bring its own. `MiddlewareChain.build`
is also the only vantage point from which the *other* half of the check is possible at all — a
configuration key that no loaded middleware claims. One typed character in
`--plugin-config RetryPolicee=…` otherwise passes every syntactic check there is and leaves the
operator watching `--verbose` print the middleware's name while it runs unconfigured.

`--plugin-config <componentType>=<json|@file>` on the CLI, `@file` for the same reason a server reads
a credential from one. `ctx.component` is exactly that validated object, delivered on every call as
`AfterParams.component` — the protocol carried no component payload before, and middleware is what
made it necessary.

One key in it is heddle's rather than the author's: `llm_config` is normalized to the camelCase
spelling `PluginModel` reads. An operator's configuration never meets the SDK's deserializer, so
without that step the spelling heddle's own error message asks for would be invisible to the code
that reads it.

### 7.5 Streaming and lifecycle — **landed, Phase 2**

**Streaming took the additive form**, which was the draft's default and is now the decision.
`Provider` gains an optional `chatCompletionStream?(signal, req): AsyncIterable<ChatChunk>`
(`llm/types.ts`), implemented by `llm/openai.ts`. The two breaking alternatives — making streaming
mandatory, or changing `chatCompletion`'s own return type — were rejected for the reason they were
always going to be: either one invalidates every provider written before it, and the point of
settling the shape in Phase 2 was to stop that from being owed to Phase 5. A caller checks for the
method and falls back, so a provider that cannot stream is not a provider that cannot be used.

**Who the fallback is actually for, and the flag that was owed alongside it.** No supported config
type reaches that fallback: `createProvider` returns an `OpenAIProvider` for every member of
`OPENAI_COMPATIBLE_TYPES`, and it always defines `chatCompletionStream`. The method check is
therefore forward compatibility for providers heddle does not ship — the Phase 5 kind, an embedder's
own `Provider` — and not a runtime choice anyone can make today. Which means the additive form on its
own turned streaming on for every heddle run against an OpenAI-compatible endpoint, with no way to
decline: an operator whose proxy handles buffered requests but not SSE, or who is billed differently
for a streamed call, had nothing to set. `Dependencies.stream` (`node/types.ts`) is that switch,
surfaced as `heddle run --no-stream` and the server's `HEDDLE_STREAM`. It sits beside `allowEnvRefs`
and `defaultLlmKey` because it is the same kind of fact — a property of the deployment and its
endpoint, not of the flow, and a spec is portable while the endpoint it lands on is not. It defaults
to on, because the streamed and buffered paths return the same `ChatResponse` and the only visible
difference is `token_delta` events that a consumer either wants or ignores — and the playground at
engine.heddle.run is the consumer the whole path exists for. It is decided before the request goes
out rather than as a fallback on a failed streamed call: re-requesting would bill twice, which is the
same reason a mid-stream failure is not retried.

Three things the contract had to decide that the draft did not raise, and the answers are the whole
of what makes streaming safe to build on:

- **The two paths are indistinguishable.** `completeChat` (`node/agent.ts`) streams when the provider
  can and buffers when it cannot, and returns the same `ChatResponse` either way. Nothing downstream
  branches on which ran. `collectStream` reassembles chunks into exactly the response the buffered
  call would have produced, including leaving `tool_calls` *absent* rather than `[]` when the model
  called nothing — the agent loop branches on precisely that.
- **Tool-call fragments are keyed by `index`, never by `id`.** Only the first fragment of a call
  carries `id` and `name`; every one after it is bare `arguments` text, and a model calling two tools
  in one turn interleaves them. Keying on `id` looks correct against a single-tool transcript and
  concatenates two argument blobs into one unparseable string against a real one. `ToolCallDelta`
  exists to make that rule a type rather than a paragraph.
- **A mid-stream failure fails the node.** This is the one thing streaming genuinely changes: a
  buffered call fails before anyone has seen anything, and a stream can fail after half an answer is
  on a client's screen. The half is not salvaged (a truncated answer would become the node's output
  with nothing marking it as truncated) and the call is not retried (it would bill twice and re-emit a
  prefix observers already hold). The error propagates, preceded by a `warning` event naming how many
  deltas are being abandoned — without which a client holding half an answer and a dead stream cannot
  tell which it is.

Deltas reach consumers as a new `token_delta` event carrying `delta: string` (`runner/events.ts`).
A delta is a report, not a result: a run can fail after fifty of them and the node then has no output
at all, so nothing downstream may treat accumulated deltas as the answer.

**Lifecycle.** `init` gives the protocol the version handshake it entirely lacked. Before it, a plugin
built against a future protocol and a host built against the current one discovered their
disagreement as "heddle does not serve X" (`host.ts`, `serve()`) or a bad result shape
(`plugin/remote.ts`, `asResult`) — both of which send a plugin author to their own handler. The
mismatch is now reported naming both versions and the plugin. See §7.1 for the compatibility rule,
which is equality, and for why an unversioned plugin is read as version 1.

`shutdown` replaces the unconditional SIGKILL with a short grace period, which matters for plugins
holding a connection pool or a file handle. It does not weaken the teardown guarantee: the SIGKILL is
armed *before* `shutdown` is written and only the process actually ending disarms it, `dispose`
remains synchronous because its caller is a `finally` that does not await, and it is still called in
that `finally` in `packages/server/src/runs.ts`.

Two protocol gaps that are not lifecycle but rode along:

- **Cancellation crosses the boundary as a request, with the kill underneath it.** `PluginContext.signal`
  and `TransformContext.signal` used to be declared, populated, and then dropped by the remote adapter,
  so an aborted run left the plugin's `execute` running until the host timeout. Phase 0 threaded the
  signal into `PluginHost.call`, which abandoned the pending call and SIGKILLed the process. Phase 2
  puts a `cancel` frame in front of that kill: the caller's promise is rejected first and
  unconditionally, then the plugin is asked to drop the call, and the SIGKILL — armed before the frame
  is written — fires `CANCEL_GRACE` later unless the plugin replies. A plugin that answers keeps its
  process, and the next node reaching it does not pay a respawn; a plugin that does not implement
  `cancel`, refuses it, or dies thinking about it is killed exactly as before. The generated runtime
  makes `ctx.signal` real on the plugin side, so cancellation is cooperative there in the ordinary
  Node sense: a handler that never reads it keeps running and its process is killed shortly after.
- **The server's per-call timeout was the whole-run budget.** `packages/server/src/plugins.ts` passed
  `config.timeout`, so one plugin call could hold a concurrency slot for five minutes with no
  independent bound, and every new `HostMethod` would have inherited that. Phase 0 gives it its own
  `--plugin-timeout`, clamped to the run budget. Phase 2 changes what that budget measures: a partial
  frame restarts it, so it bounds *silence* rather than total time.

### 7.6 Provider plugins — **landed, Phase 5**

```ts
// packages/core/src/plugin/types.ts
export interface PluginProviderDef extends PluginComponentDef {
  /**
   * Lifetime is per compiled graph, not per execute. All three callers memoize
   * now — `AgentExecutor`, `PluginModel` and, since this phase, `LLMExecutor`,
   * which rebuilt on every execution and would have silently defeated a
   * provider holding a token bucket or a response cache.
   */
  createProvider(config: PluginComponent, deps: Dependencies): Provider;
}
```

Three prerequisites, all discharged:

1. ~~**`Dependencies` gains a factory.**~~ **Landed.** `createProvider` was a directly-imported free
   function called from `node/agent.ts`, `node/llm.ts` and `plugin/services.ts`, each rebuilding the
   same options object from the same three `Dependencies` fields. All three now call `providerFor`
   (`llm/provider.ts`), which is the single seam: it consults the plugin registry for a non-builtin
   config type, and otherwise defers to `Dependencies.createProvider ?? createProvider`.

   The ordering is the load-bearing part. A builtin type never reaches the registry, so a plugin
   cannot become the endpoint for a flow that wrote `OpenAiConfig` — and an embedder's override
   replaces heddle's own construction *without* disabling providers an operator loaded, because
   those two are different questions and one field answering both would make a stub into a silent
   feature switch.
2. ~~**`ChatRequest` must carry something worth acting on.**~~ **Landed with Phase 4.** It was
   `{ model, messages, tools? }` and `defaultGenerationParameters` (`spec/types.ts`) was — grep-confirmed
   — read nowhere, so no spec could set a temperature or request JSON mode. `ChatRequest`
   (`llm/types.ts`) now also carries `temperature`, `maxTokens`, `topP` and `responseFormat`, and
   `generationParams` (`llm/provider.ts`) reads the spec field into them for `AgentExecutor` and
   `LLMExecutor` alike.

   Two spellings settled here. The parameters use the SDK's own names — `LlmGenerationConfig` is
   `{ maxTokens, temperature, topP }` — so the spec-to-request mapping is an identity rather than a
   rename that can be got wrong in one direction, and the translation to `max_tokens`/`top_p` happens
   once, in the vendor's adapter. `responseFormat` is `'text' | 'json'` rather than OpenAI's
   `{ type: 'json_object' }`, on the same rule as `ChatChunk`: every provider can do JSON and each
   does it differently — Ollama takes `format: 'json'`, Anthropic has no field and does it with a
   tool — so encoding one vendor's structure here would make the others translate *out* of a shape
   they do not have.

   What is still absent from seam #26: `seed` and `stop`. Neither has a caller yet, and because
   `LlmGenerationConfigSchema` is a passthrough, a spec that sets them today deserializes intact and
   is dropped rather than refused — which is what lets a spec written for another engine's parameters
   run here at all.
3. **`Provider` already carries its streaming form** — settled in Phase 2, not here (§7.5).
   `chatCompletionStream?(signal, req): AsyncIterable<ChatChunk>` is on the interface, optional, with
   `llm/openai.ts` its only implementation so far. A provider contract published without it would have
   been a contract that breaks later.

   **The bridge between two shapes of stream landed with the rest, and it was not free.** A
   `Provider` streams by *pull*: an `AsyncIterable` the consumer drives, which ends by returning and
   fails by throwing, so back-pressure and mid-stream failure both have somewhere to live. A plugin
   streams by *push*: `{ id, partial }` frames the host receives whenever they arrive, delivered to
   an `onPartial` callback (`PluginHost.call`) that has no way to say "slower", no end marker, and no
   failure channel except the call's own response. `pullFrom` (`plugin/remote.ts`) presents the
   second as the first, under three rules stated in the protocol rather than discovered by the first
   plugin: each partial's payload is one `ChatChunk`; **the call's response is itself the final
   chunk** and the end of the stream, so a call that ends without one is a failed call and not an
   empty answer; and a plugin that streams for longer than the per-call timeout stays alive only
   because each partial resets it (§7.1), which means a provider that buffers internally and emits
   nothing is killed exactly like one that hung.

   Two consequences worth recording. There is **no back-pressure and cannot be** — the plugin writes
   to a pipe heddle drains, so a slow consumer grows a queue rather than slowing the producer; in
   practice the consumer is `collectStream`, which appends and emits an event. And **whether a
   component streams is a manifest field**, not a per-call negotiation: `completeChat` decides by
   whether `chatCompletionStream` exists, synchronously, so `remoteProviderDef` defines that method
   only when the manifest declared `stream`. A provider that never implemented streaming is
   therefore never sent `stream: true` and never has to answer a mode it has no handler for.

**The placeholder-`LLMConfig` problem — resolved, and kept as the record of what was avoided.**
Everything below describes the cost of making a provider *spec-named* (a flow writing
`component_type: AnthropicConfig`) **under the placeholder mechanism**. None of it was paid: vendor
patch 3 opened `LlmConfigUnion` behind a lazy reference, `spec/open-unions.ts` widens it with the
same plugin-independent schema the other two use, and a plugin config now deserializes in place. The
analysis stays because it is the sharpest illustration of why the placeholder approach did not scale
— one registration replaced all four restore paths described below.

Under placeholders, this would have been the most expensive stand-in yet:

- `LlmConfigUnion` gates three distinct positions: `Agent.llmConfig` (`vendor/agentspec/src/agents/agent.ts:17`),
  `LlmNode.llmConfig`, and both transforms' `llm` (`vendor/agentspec/src/transforms/message-transform.ts:29,53`).
- The stand-in must be a real member of that union with its required fields synthesized — exactly
  what `PLACEHOLDER_LLM` already does (`plugin/flow-preprocess.ts:41-46`, an `OllamaConfig` with a
  fake `url` and `model_id`).
- Restoration is the expensive half. A node stand-in restores in one lookup (`spec/adapter.ts:166-169`)
  because it is a top-level element. A transform stand-in already costs ~30 lines because it must
  **rebuild the frozen `Agent`** (`spec/adapter.ts:131-160`; the comment at `:128-129` notes the SDK
  freezes what it builds). An `llmConfig` is nested one level deeper still and appears in three
  places, so it needs a third restore path that rebuilds the same frozen ancestor for a different
  field.
- And a placeholder that escapes is a real hazard: if a spec is ever serialized before swap-back, a
  fake `OllamaConfig` pointing at `localhost:11434` is what gets written.

**The alternative is host-configured providers**: the operator maps a config type to a plugin at
load time, and the spec writes an ordinary `OpenAiCompatibleConfig`. Zero placeholder tax, zero SDK
involvement, and it matches the current stance that plugins are named by the operator. What it loses
is the ability for a spec to *say* which provider it wants — which is arguably the point of a spec
format.

That fork was genuinely balanced only while the placeholder was the sole route, and it was not:
**`LlmConfigUnion` was extended in the vendored SDK and spec-named providers cost nothing extra**, so
the spec keeps the ability to name its own provider and heddle keeps one mechanism instead of two.
The host-configured form was never built, and there is now nothing it would buy — a middleware is
the kind for something the operator installs and a flow does not mention, and it already exists.

### 7.7 Registry / tool-source plugins

`Registry` is two methods (`packages/core/src/tool/types.ts`, `Registry`) — the cheapest component kind on
the list, and demand is proven: the server had to write registry composition *outside* core
(`packages/server/src/tools.ts:15-29`) because none existed inside.

The one real constraint: **`lookup` must stay synchronous.** It is called inside execution at
`node/agent.ts:267` and `plugin/remote.ts`'s `toolRunner`, and at request-validation time by
`assertToolsAvailable` (`packages/server/src/tools.ts:39`). A synchronous call cannot cross the pipe.

So a registry plugin is a **discovery** plugin, not a live registry:

- The manifest declares its tools as data — the same trick as `inputs`/`outputs`
  (`plugin/manifest.ts:1-19`), and it keeps `parseFlow` synchronous.
- An optional `listTools` `HostMethod` covers genuinely dynamic sources (MCP server discovery), but
  it starts the process during load, which is exactly the property `remote-loader.ts:109-111`
  protects. So it is opt-in per plugin, and it does *not* run on the `/v1/validate` path.
- Results are cached for the run. `lookup` is served from the cache.

This also fixes a smaller annoyance: `FileRegistry` gives every discovered tool
`description: ''` (`packages/core/src/tool/registry.ts:52-56`) and never populates `inputSchema`
(`tool/types.ts:8-9`), so a tool's description reaches the model only if the spec repeats it
(`node/agent.ts:100`). A manifest-driven registry has one source of truth.

### 7.8 Worked examples

**(a) Retry middleware on `nodeError`.**

```json
{
  "name": "resilience",
  "version": "1.0.0",
  "capabilities": ["emitEvent"],
  "components": [{
    "componentType": "RetryPolicy",
    "kind": "middleware",
    "seams": ["nodeError"],
    "schema": {
      "type": "object",
      "properties": {
        "maxAttempts": { "type": "integer", "minimum": 1, "maximum": 10 },
        "retryOn":     { "type": "array", "items": { "type": "string" } }
      },
      "required": ["maxAttempts"],
      "additionalProperties": false
    }
  }]
}
```

```js
// resilience.mjs — the runtime is prepended by heddle (withRuntime, plugin/runtime-source.ts)
serve({
  RetryPolicy: {
    after(params, ctx) {
      const { seam, subject, outcome, attempt } = params;
      if (seam !== 'nodeError' || outcome.ok) return { action: 'pass' };

      const max = ctx.component.maxAttempts;
      const allowed = ctx.component.retryOn;
      if (allowed && !allowed.includes(outcome.error.name)) return { action: 'pass' };

      if (attempt >= max) return { action: 'pass' }; // out of attempts: the original error stands

      ctx.emitEvent('retry', { node: subject.nodeName, attempt, of: max });
      return { action: 'retry', delayMs: 250 * 2 ** (attempt - 1) };
    },
  },
});
```

The middleware holds no state at all. `attempt` comes from the host, which owns the retry loop and
is the only party that can count it correctly across re-invocations (§7.1); a module-scope
`Map` keyed by `callId` would count 1 forever, since `retry` re-enters with a fresh `callId` (§7.4).
`maxAttempts` is host-configured — the operator supplies it as
`--plugin-config RetryPolicy='{"maxAttempts":3}'`, checked against the manifest `schema` above when
the chain is built (§7.4), and the host's own ceiling still applies underneath it.

**(b) An LLM-judge node, using `callModel`.** This one is no longer a sketch — it is what Phase 4
made writable, and `plugin/__tests__/model.test.ts` runs a plugin shaped exactly like it.

```json
{
  "name": "judge",
  "version": "1.0.0",
  "capabilities": ["callModel", "emitEvent"],
  "components": [{
    "componentType": "LlmJudge",
    "kind": "node",
    "inputs":  [{ "title": "answer", "type": "string" }],
    "outputs": [{ "title": "verdict", "type": "string" },
                { "title": "score",   "type": "number" }],
    "branches": ["accept", "reject"],
    "schema": {
      "type": "object",
      "properties": { "rubric": { "type": "string" }, "threshold": { "type": "number" } },
      "required": ["rubric"]
    }
  }]
}
```

```yaml
# The flow names the model. The plugin does not, and cannot.
- component_type: LlmJudge
  name: judge
  rubric: "Is the answer supported by the sources?"
  llm_config:
    component_type: OpenAiConfig
    model_id: gpt-4o-mini
    default_generation_parameters: { max_tokens: 256 }
```

```js
serve({
  LlmJudge: {
    async execute(input, ctx) {
      const { rubric, threshold = 0.7 } = ctx.node;
      // No API key here, and no SDK. The plugin's environment is empty
      // (PluginHost.resolveCommand); the host holds the credential and makes the call.
      const resp = await ctx.callModel({
        messages: [
          { role: 'system', content: `Score against this rubric. Reply {"score":0..1,"why":"..."}.\n${rubric}` },
          { role: 'user',   content: String(input.answer ?? '') },
        ],
        responseFormat: 'json',
        // Overrides the spec's default for this call only; max_tokens above survives.
        temperature: 0,
      });
      const { score = 0, why = '' } = JSON.parse(resp.content);
      return {
        output: { verdict: why, score },
        branch: score >= threshold ? 'accept' : 'reject',
      };
    },
  },
});
```

`branches` is declared in the manifest because `graph/validate.ts:26-42` checks reachability before
anything runs, and `PluginNodeAdapter` rejects an undeclared branch with a message that names the
declared set (`plugin/executor.ts`'s `runNode` branch check) rather than letting it surface as a confusing
"no next node" from `runner.ts:94-97`.

**(c) An Anthropic provider (host-configured form).**

```json
{
  "name": "anthropic-provider",
  "version": "0.3.0",
  "capabilities": [],
  "components": [{ "componentType": "AnthropicConfig", "kind": "provider" }]
}
```

```js
serve({
  AnthropicConfig: {
    async chat({ config, request }) {
      const res = await fetch(`${config.url ?? 'https://api.anthropic.com'}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.apiKey,          // from the component's own spec fields
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(toAnthropic(request)),
      });
      return fromAnthropic(await res.json());
    },
  },
});
```

Note `capabilities: []`. A provider plugin needs nothing back from heddle — but it does need
**network access**, which the process boundary does not restrict and the sandbox might
(`PluginHost.resolveCommand`, `plugin/host.ts`, `resolveCommand`). That is a policy question the capability list does not currently
model, and it is one of the open questions below.

### 7.9 The `encoder` kind — **landed**

> **What shipped differs from the proposal below in two ways, both found by
> reading AG-UI's actual schema rather than its prose.**
>
> **The selector is a protocol name, not a media type.** This section proposed
> `contentType` as the identity and selection by `Accept:`. That does not work:
> heddle's own frames and AG-UI's are *both* `text/event-stream`, differing only
> in what the frames contain, so a media type cannot choose between them.
> `PluginEncoderDef` therefore carries a `protocol` — `ag-ui`, in its own
> namespace beside component types and tool names — selected with
> `?protocol=ag-ui` beside the `?stream=true` that already decides whether there
> are frames at all. `contentType` survives as the *response header*, which is
> what it always described.
>
> `application/vnd.ag-ui+json`, which this section invented, is not a real AG-UI
> media type. Over SSE the protocol is plain `text/event-stream`.
>
> **A frame's event name is optional.** AG-UI writes nameless `data:` frames with
> its type *inside* the payload, in `SCREAMING_SNAKE`; heddle's own frames put the
> type in the SSE event name so a browser can subscribe to it. An encoder that
> could not say "no name" could not produce a conformant AG-UI stream, so
> `WireFrame.event` is optional and `SseStream.sendFrame` writes both shapes.
>
> Also worth recording, because it cost a wrong field name: the prose docs' table
> for `RunFinished` lists only `outcome` and `result`, while the schema requires
> `threadId` **and** `runId`. The example was written against
> `sdks/typescript/packages/core/src/events.ts`.

#### What landed

| Landed | Where |
|---|---|
| `encoder` as a sixth `ComponentKind`, claimed in `defs` so `kindOf` can refuse a spec that names one, and kept out of `componentTypeNames()` | `plugin/registry.ts` |
| A third namespace: encoders by `protocol`, with `claimProtocol` refusing a malformed name, a missing `contentType`, a collision between two plugins, and `heddle` itself | `plugin/registry.ts` |
| `WireFrame`, `PluginEncoder`, `PluginEncoderDef` | `plugin/types.ts` |
| `serializeEvent` moved into core, and heddle's own frames re-expressed as `builtinEncoder()` — one encoder among however many, reachable by name as `?protocol=heddle` | `plugin/encoder.ts` |
| `EncoderStream`: the ordered drain that lets a synchronous `EventHandler` feed an encoder that answers over a pipe | `plugin/encoder.ts` |
| `encode` and `finishEncode` verbs, and `readWireFrames` | `plugin/protocol.ts` |
| `EVENT_CONTRACT_VERSION`, sent to every plugin at `init` as `events` | `runner/events.ts`, `plugin/host.ts` |
| `remoteEncoderDef`, which threads no signal and needs no capability | `plugin/remote.ts` |
| `protocol` and `contentType` in the manifest, required on an encoder and refused on every other kind | `plugin/manifest.ts` |
| `?protocol=` selection, an unknown protocol refused 400 naming what it can render, a protocol without `stream=true` refused, and the encoder's `contentType` as the response header | `server/encoders.ts`, `server/runs.ts`, `server/server.ts` |
| A per-run `runId`, minted per request | `server/runs.ts` |
| `protocols` and `eventContract` on `/v1/capabilities` | `server/capabilities.ts` |
| The AG-UI encoder, exercised end to end through HTTP | `examples/ag-ui/` |

**The message-boundary decision this section asked for: it is the encoder's, and
heddle emits nothing.** The argument is that heddle does not know where a
*message* begins — it knows where a *node* begins. To emit `TextMessageStart`
itself it would have to claim a message was starting before knowing whether the
node will produce one, and §7.5's own note names two ordinary configurations
where it will not: an agent carrying a `post` transform streams nothing, and one
calling tools streams rounds whose text is discarded. Delaying the claim until
the first delta would make it exactly what an encoder can already do for itself.
What heddle does supply is the two facts that make the bookkeeping cheap:
`token_delta` carries `nodeName`, and the runner is a single sequential loop, so a
node's deltas are contiguous.

**The boundary turned out to be one of five disagreements, not the only one, and
the adversarial review is what found the other four.** All four were in the
example rather than the engine, and each is a place where heddle's event model and
AG-UI's are both reasonable and do not line up:

- **A message id has to be minted per node *visit*.** `attempt` cannot serve: it
  is absent from `token_delta` altogether, and `runner.ts` resets it to 1 when the
  flow advances, so a loop revisiting a streaming node reuses an id whichever way
  it is read. AG-UI's reducer treats a repeated `TEXT_MESSAGE_START` as a no-op
  and *appends* the content, so a reused id does not fail — it silently
  concatenates two turns into one message.
- **A step closes on `node_error` too.** A retry re-enters the node and emits a
  second `STEP_STARTED`, and AG-UI's verifier — which sits unconditionally in its
  client's pipeline — refuses one for a step already active. A step left open
  there makes a conforming client abort a run heddle went on to complete, which is
  the one outcome a non-terminal error must not cause.
- **A tool message needs an id of its own.** `TOOL_CALL_RESULT.messageId` names a
  *new* tool message, not the parent assistant one, so reusing the node's id
  collides with the assistant message and with every other result in that node —
  and a client keyed by message id keeps one of them.
- **A failed tool is a result whose content is the error.** heddle emits
  `tool_result` with an `error` and no `toolResult`; AG-UI's frame has a required
  `content` and no error field at all, so a failure renders into `content` or it
  is lost — and lost, it reads as a tool that successfully returned nothing.

Plus one trap that is not a disagreement so much as a mismatch of scope:
`STATE_SNAPSHOT` **replaces** the client's whole state, while `node_complete.state`
is only that node's own output. Sending the second as the first deletes what
earlier nodes and the run's inputs put there, so the encoder accumulates the run
state the way the runner does. The example's own flow hides this, because
`StartNode` and `EndNode` compile to a passthrough whose output *is* the merged
state — which is exactly why it took a review to find.

None of these is a defect in the kind, and that is the point worth keeping: every
one is a decision an encoder author has to make, all five are invisible from
heddle's side, and the example is where they are now written down.

**An encoder failure ends the stream and the run.** With one selected, the
encoding *is* the response, so a run whose answer nobody can read is not worth
spending the caller's money and a concurrency slot on — the same rule as the
`res.on('close')` abort when a caller hangs up. The failure travels on heddle's
own error channel rather than the selected protocol's, because a rendering that
just failed is not the thing to report it with.

**`finish()` is told nothing about the outcome, and does not need to be.** AG-UI's
`RUN_FINISHED` and `RUN_ERROR` are mutually exclusive, so the example has to know
which happened — and reads it off the stream, since heddle emits `flow_complete`
only on success. That is the one-directional rule paying for itself: the encoder
infers what happened instead of being handed a verdict, which is why this kind
needs no return path. It is also why `node_error` is *not* rendered as
`RUN_ERROR`: since Phase 6 a node error is not terminal, so a client told the run
had failed would be wrong whenever a middleware retried.

**Still owed, and stated rather than papered over: the CLI cannot select one.**
`heddle run` renders events with its own progress writer and has no `--protocol`,
so an encoder is reachable from the server and from an embedder holding
`RunnerOptions`, and not from the CLI. Recorded for the same reason Phase 6
recorded the TUI's silence about `warning`: a contract nothing draws is not yet a
feature. The shipped example is therefore submitted with a request, which is how
it will really be used.

#### The original argument

Every kind so far answers "what runs inside a flow". This one answers "what the run looks like on
the wire", and it falls outside the taxonomy in §5 — it is neither a spec-named slot nor an
interception around an engine step. It is a **sink on the event stream**.

Today that layer is a free function with exactly one rendering:

```ts
// packages/server/src/sse.ts — serializeEvent
export function serializeEvent(e: Event): Record<string, unknown> {
  return { type: e.type, nodeName: e.nodeName, /* … */ };
}
```

**The motivating case: AG-UI.** [AG-UI](https://docs.ag-ui.com) is a streaming event protocol for
agent↔UI interaction. heddle's runner events already carry most of its lifecycle:

| heddle `Event` | AG-UI event |
|---|---|
| `flow_start` (`runner.ts:26`) | `RunStarted { threadId, runId }` |
| `flow_complete` (`runner.ts:85`) | `RunFinished { outcome?, result? }` |
| `node_error` (`runner.ts:66`) | `RunError { message, code? }` |
| `node_start` / `node_complete` (`runner.ts:47,77`) | `StepStarted` / `StepFinished { stepName }` |
| `tool_call` (`node/agent.ts:199`) | `ToolCallStart` + `ToolCallArgs` + `ToolCallEnd` |
| `tool_result` (`node/agent.ts:217`) | `ToolCallResult { messageId, toolCallId, content }` |
| `node_complete.state` | `StateSnapshot { snapshot }` |
| `token_delta` (`node/agent.ts`, Phase 2) | `TextMessageContent { delta }` |

Seven of eight rows are a rename and an id. The eighth was the one that mattered, and it is why this
kind was scheduled after streaming: AG-UI's value is `TextMessageContent` **deltas**, and heddle
produced none — an encoder built before Phase 2 could emit only `TextMessageChunk` with the entire
answer as one delta, which is spec-legal (every field but `type` is optional) and misses the point
entirely. Phase 2 closed that: `token_delta` carries one fragment of a model's answer in the order
the model produced it, named with the node it belongs to.

What is still missing is the *framing* either side of it. AG-UI wants `TextMessageStart` and
`TextMessageEnd` around a run of deltas, and heddle emits no event at either boundary — an encoder
has to synthesize both by watching for the first `token_delta` after a `node_start` and for the
`node_complete` that follows. That is bookkeeping an encoder can do (`createEncoder(runId)` is
per-run precisely so it can), but it is bookkeeping every encoder would redo, and it is the argument
for deciding in Phase 9 whether the boundary is heddle's to emit.

**Why not a node or a transform.** Both were considered and both are the wrong layer:

- A **transform** sees `Message[]` at two taps and returns `pass | modify | reject`. `TransformContext`
  is `{ signal, phase, component }` plus the Phase 3 reporter (`plugin/types.ts`,
  `TransformContext`), so it can now *add* to the run's stream — but only its own namespaced events,
  and it sees none of the engine's. There is still no path from it to the rendering of the run. It is
  a message filter; AG-UI is a wire format.
- A **node** returns `{ output, branch }` once, at the end (`plugin/types.ts`, `PluginResult`). A terminal node
  could return an array of AG-UI events as its output, but that is a batch, not a stream, and it sees
  only its own input rather than the run's events.

An encoder is a **rendering of the run**, not a step in it.

```ts
// packages/core/src/plugin/types.ts — proposed
export interface PluginEncoderDef extends PluginComponentDef {
  /** Wire content type this encoder produces, e.g. "application/vnd.ag-ui+json". */
  contentType: string;
  /**
   * Per-run, not a pure function. AG-UI requires threadId/runId/messageId
   * bookkeeping that only makes sense across a whole run, and `TextMessageStart`
   * has to be emitted before the first delta the encoder has seen.
   */
  createEncoder(runId: string): PluginEncoder;
}

export interface PluginEncoder {
  /** One runner event in, zero or more wire frames out. */
  encode(event: Event): Promise<WireFrame[]> | WireFrame[];
  /** Flush trailing frames — AG-UI needs `RunFinished` even on an aborted run. */
  finish(): Promise<WireFrame[]> | WireFrame[];
}
```

Two properties make this the cheapest kind on the board:

- **No placeholder cost.** It never appears in a spec document, so §8 does not apply — the only kind
  of which that is true. It is selected by the request (`Accept:` header, or `?protocol=ag-ui` on
  `POST /v1/runs`), which is also the right place: two clients hitting the same flow can want
  different renderings.
- **No capability surface.** `Event → WireFrame[]` needs nothing from the host. An encoder is the one
  plugin that can be granted the empty capability set and still do its job.

The one genuine cost is that opening this layer makes the `Event` shape a **public contract**. `Event`
(`runner/events.ts`, `Event`) is a struct that `serializeEvent` mirrors by spreading;
`packages/server/src/sse.ts:4-18` is explicit that the wire form is the engine's own model. Once
third-party encoders consume it, adding a field is fine and changing one is a break. That argues for
versioning `Event` at the same time.

The precondition this paragraph used to ask for is met: the namespaced `EventType` widening landed in
Phase 3, so an encoder written now sees the final shape — `BuiltinEventType | PluginEventType`, with
`data` and `level` on `Event` — rather than a closed enum that would grow under it.

### 7.10 Open questions

1. **~~Spec-named or host-configured providers?~~ Resolved by §8, and shipped spec-named in Phase 5.**
   This was balanced only while the placeholder was the only route to a custom `LlmConfig`. Vendor
   patch 3 extended `LlmConfigUnion`, which costs nothing per-provider, so spec-named won and the
   host-configured form was never built. Kept here rather than deleted because the reasoning inverts
   again if the SDK work is ever abandoned — and because it names the thing that decided it, which is
   that a spec saying where its run sends requests is the point of a spec format.

   Phase 4 narrowed what this question is *about*, and the narrowing is worth recording. A plugin
   naming its model in the spec turned out to cost nothing at all: a plugin component's fields are
   not checked against any union, so an ordinary `llm_config` on a `LlmJudge` deserializes through
   the SDK's own path — camelCased, `defaultGenerationParameters` intact — and `PluginModel` reads it
   directly. Only a plugin that *implements* a provider (a new `LlmConfig` **type**, Phase 5) needs
   `LlmConfigUnion` opened. Consuming a model was never the expensive half.
2. **~~Does `retry` belong on `nodeError` only, or on every seam?~~ Resolved in Phase 6: per seam,
   declared as data.** The question was right about the asymmetry and wrong to treat it as one
   decision. `SEAMS[seam].after` names the verdicts each call site can honour, so `retry` is
   admissible at the node position and absent at `toolCall`, and `readAfterVerdict` refuses it there
   rather than honouring it into a corrupted message array. The plugin learns the same set at `init`,
   so a middleware that wants to work at both seams can fall back to `replace` instead of being
   refused mid-run — which, under the fatal policy, would cost the run.
3. **~~Is a middleware failure fatal or skipped?~~ Resolved in Phase 6: fatal, on every seam, with no
   opt-out.** The argument is in §7.4 and turns on two things the question did not state. The
   objection against the tempting split is not that both halves are wrong — it is that the split has
   no survivable side, since both halves say failing open is wrong. And the observe-only category the
   split presumes does not exist: every middleware returns a verdict, and a component that only wants
   to watch already has `emitEvent` and `log`, which cannot fail a run. The carve-out that makes it
   affordable is in the reporting: on `nodeError` the run fails with the node's own error and the
   middleware failure as `cause`.
4. **Network policy for plugins.** The current model denies the environment and (optionally) the
   filesystem; it says nothing about the network. Example (c) needs it, guardrails plugins must not
   have it. Neither `SandboxPolicy` nor the capability list expresses it today.

   **Phase 5 made this concrete rather than hypothetical.** A provider plugin's whole job is an
   outbound request, so it is the first kind that is useless without network and the first whose
   network access an operator would obviously want to scope — to the one host its config names. The
   capability model cannot express that, because a capability gates a *reverse call* and this is not
   one: the plugin reaches the network on its own, through its own runtime, and heddle never sees it.
   Whatever answers this will be a sandbox policy, not a `PluginCapability`. This is now the largest
   open item in the security model.
5. **Should `getState` exist at all?** It requires threading `currentState` through `Dependencies`,
   and the value it adds over the node's resolved input is small in practice, since `resolveInputs`
   returns the whole accumulated state whenever a node has no mappings (`runner.ts:112-114`). Weakest
   item in §7.2.
6. **Does `listTools` justify starting a process during load?** It breaks the one property that makes
   `/v1/validate` cheap (`remote-loader.ts:109-111`). Manifest-declared tools cover most real cases;
   MCP discovery is the case that does not, and it is the case people will ask for.
7. **Should a plugin ever be allowed to claim a builtin type?** Phase 5 answered this for one kind
   and left it open for the rest: a *provider* must never claim one, because a flow writing
   `OpenAiConfig` and reaching a stranger's code is a capture rather than an extension — so
   `providerFor` checks builtins before the registry as well as `claim` refusing the registration.
   Any future opt-in has to carve providers out. `plugin/registry.ts` forbids it generally,
   which means the two transforms heddle skips (`plugin/transform.ts`, `BUILTIN_TRANSFORMS`) can never be supplied by
   a plugin — the feature is impossible in both directions at once. Allowing it needs a precedence
   rule and an explicit `implements: "builtin"` opt-in so shadowing is visible, and the compiler's
   plugin-first lookup (`graph/compile.ts:74-80`) would need its comment corrected.
8. **How does a plugin's model answer ever get streamed?** Phase 4 buffers `callModel`, because
   heddle cannot tell a plugin's model call from its scratch work and streaming it would publish
   scratch as the run's answer (§7.2). That is right for a judge and wrong for a summarizer plugin
   whose model output *is* the node's output — and heddle has no way to be told which it is. The
   candidates are a manifest flag on the component (declarative, checkable at load, and a plugin can
   still lie about which calls are the answer), a distinct verb, or leaving it to the encoder to
   decide what a client sees. None is obviously right, and nothing is blocked on it today.

   **Phase 9 built the third candidate and it does not answer this.** An encoder now exists and can
   drop or relabel any event, so "let the rendering decide" is reachable — but it decides for *every*
   client of that protocol at once, from outside the plugin, with no way to tell one plugin's scratch
   from another's answer. The information the question is missing is which calls are the answer, and
   an encoder has strictly less of it than heddle does: it sees the events, not the call sites. What
   an encoder *does* settle is the weaker version of the question — a client that wants none of a
   plugin's chatter can ask for a protocol that renders none of it — which is a filtering decision
   and was never the hard part. The manifest flag remains the only candidate that puts the claim
   where the knowledge is.

---

## 8. The agentspec placeholder tax — and how to stop paying it — **paid off**

> **Historical.** Phase V opened `NodeUnion` and `MessageTransformUnion`; Phase 5 opened
> `LlmConfigUnion`, which is the row this section prices as the worst of them. No placeholder was
> ever built for a config, and the substitution machinery for the other two is deleted. The section
> is kept because it is the argument that decided the approach, and because the last row —
> `ToolUnion` — is the one case still unpriced.

Every new **component** kind — as opposed to a middleware or a `PluginMethod` — needed a hand-picked
placeholder, because the SDK's unions were closed (§2.4) and heddle's only tool was substitution.

A placeholder is not one constant. It is four things:

| Requirement | Node today | Transform today | An `LlmConfig` would need |
|---|---|---|---|
| A builtin inert enough to survive validation | `InputMessageNode`, chosen because its factory passes `inputs`/`outputs` through untouched (`flow-preprocess.ts:27-32`) | `MessageSummarizationTransform` (`:34-39`) | one of five `LlmConfigUnion` members |
| Synthesized required fields | 5 (`:109-115`) | 4, including a whole fake `OllamaConfig` (`:41-46,120-125`) | at minimum `model_id` + `url` |
| A restore path | 1 lookup, `spec/adapter.ts:166-169` | ~30 lines rebuilding the frozen `Agent`, `spec/adapter.ts:131-160` | a third path, rebuilding the same frozen ancestor for a different field, in three positions |
| A guarantee it never serializes | holds because restore precedes any export | holds | would need checking — the placeholder points at `localhost:11434` |

The scaling is bad in a specific way. It is not that four placeholders are worse than three; it is
that **restore cost grows with nesting depth while placeholder cost grows with the union's field
requirements**, and the two multiply. A top-level node is cheap on both. A transform is one level
down and its placeholder needs a nested component. An `llmConfig` is one level further down again
and appears in three positions. A custom `Tool` type would be a fourth.

Where the crossover is, concretely. Extend the SDK (§8.1) instead of adding a placeholder when
**any** of these holds:

1. The stand-in must synthesize a field whose value the SDK validates *against another field* — at
   that point you are not substituting, you are forging a consistent document.
2. The restore path must rebuild more than one frozen ancestor.
3. The slot appears in three or more positions, so one placeholder needs three restore sites that
   must stay in agreement.

The `LlmConfig` case trips (3) and arguably (2). **That is the point to stop adding placeholders** —
and since the SDK is ours to patch, that point is now.

### 8.1 Paying it off: extend the vendored SDK

An earlier draft treated this as an upstream contribution to wait on, because `VENDOR.md` recorded
no local modifications at all. That constraint is a choice, not a fact, and dropping it is the single
highest-leverage decision in this document.

The blast radius is unusually small. The SDK **is not published to npm**, and consumers list it as a
devDependency and bundle it into their own `dist/` via tsup's `noExternal` (`VENDOR.md:18-20,51-55`).
There is no downstream consumer to break — only heddle builds against this tree.

The work, in two tiers:

| Tier | Change | Cost | Buys |
|---|---|---|---|
| 1 | Re-export `registerNodeUnionSchema` and `registerFlowSchema` from `vendor/agentspec/src/index.ts` | **2 lines** — both already exist as `export function` at `flows/lazy-schemas.ts:28,33` | custom nodes stop needing a placeholder |
| 2 | Add the `LazyNodeRef` indirection + a registration function for `MessageTransformUnion`, `LlmConfigUnion`, `ToolUnion` | real work — none of the three has any lazy indirection today | every remaining component kind, including providers, at zero placeholder cost |

Tier 1 alone deletes the node half of `plugin/flow-preprocess.ts`. Tier 2 deletes the module. The
prize is stated in its own docblock (`flow-preprocess.ts:19-21`): it collapses into registering the
plugin's schemas.

Three more gaps are worth closing in the same pass, all of which cost heddle code today:

| Gap | What it costs now |
|---|---|
| No zod analogue of Python's `PydanticComponentSerializationPlugin` | every custom type needs a hand-written deserializer |
| `BuiltinsComponentDeserializationPlugin` not exported from the root | `plugin/deserializer.ts:35-59` re-declares `PROTOCOL_FIELDS` / `DANGEROUS_KEYS` / `OPAQUE_FIELDS` |
| `SerializedDict` / `SerializedFields` not exported | `plugin/deserializer.ts:17-20` recovers them via `Parameters<>` |

Between them, most of `deserializer.ts`'s 207 lines.

**The cost, stated honestly.** This is a fork of the *validation* layer of a format heddle does not
own — normally the most expensive kind to carry. Two things make it tolerable here and neither should
be assumed away:

- The refresh story in `VENDOR.md` becomes "rebase our patches onto upstream" rather than "re-copy".
  Keep the changes as a numbered patch series with a `## Local modifications` section replacing the
  current "None", so the next person refreshing the vendor knows what they are reapplying.
- Upstream the same changes in parallel. They are small, additive, and useful to anyone else
  implementing a runtime on the TS SDK. But **do not sequence anything behind Oracle merging them** —
  that was the original error in scheduling this work last.

One exception worth noting because it costs zero tax either way: a custom **Tool** may not need a
placeholder *or* a union change. `BuiltinTool` has a free-form `toolType: z.string()` and an opaque
`configuration: z.record(z.unknown())` (`vendor/agentspec/src/tools/builtin-tool.ts:8-14`), and
opaque fields round-trip untouched. It is a union-safe channel that upstream appears to have
intended for exactly this. Worth evaluating before designing a `kind: 'tool'`.

---

## 9. Roadmap

Phase numbers are identities, not an execution order. Two phases moved after the first draft and the
numbering was left alone so cross-references stay valid. The actual order:

| Phase | Needs | Notes |
|---|---|---|
| 0 Debts | — | landed |
| 1 Capabilities | 0 | landed; gates everything that widens `PluginMethod` |
| 2 Lifecycle + streaming | 1 | landed |
| 3 `PluginContext` | 1, 2 | landed |
| 4 `callModel` | 1, 3 | landed; also carried seam #26 (`ChatRequest` widening) |
| 5 Provider kind | 2, 4 | landed; *strongly preferred* V, and took it |
| 6 Middleware kind | 1, 2, 3 | landed at `nodeError`; five seams reserved |
| 7 Registry | 1 | landed; off the main line |
| 9 Encoder | 2, 3 | landed; off the main line |
| **V** SDK extension | — | landed; independent; landed before 5 |

Every phase in this table has landed. What remains is recorded per phase below —
Phase 6's five reserved seams, and the two surfaces neither Phase 6 nor Phase 9
reaches (the server installs no middleware; the CLI selects no encoder) — plus
the open questions in §7.10, of which Q4 is the largest.

Three things moved after the first draft:

- **V** (vendored SDK extension) was Phase 8, scheduled last as an upstream contribution to hope for.
  It is a local change (§8.1), it blocks nothing, and it makes Phase 5 dramatically cheaper — start it
  immediately and run it alongside.
- **Streaming** moved from Phase 5 into Phase 2, where the frame that carries it already lives (§7.5).
- **9** (encoder) is new, and sits after 3 because its motivating consumer wants a real token stream.

### Phase 0 — Debts that any widening makes worse — **landed**

No protocol change. Done first because each one is a bug that a wider surface multiplies.

| Item | Where | Why now |
|---|---|---|
| Type `PluginHost.call(method: HostMethod, …)` | `plugin/host.ts`; the types were unreferenced (`protocol.ts`) | With 8 verbs instead of 2, an unchecked string is a real defect class |
| Give remote transforms their `deps` and a tool runner | `plugin/remote.ts` vs `plugin/types.ts` | §4 — capability must not depend on graph structure |
| Restore plugin transforms on the Agent paths | `spec/parser.ts` | `heddle validate <agent> --plugin` returned placeholders |
| One authoritative tool-argument parse | `node/agent.ts`, `parseToolArguments` | A `toolCall` hook cannot receive two disagreeing parses |
| Decide the server's per-call plugin timeout | `packages/server/src/plugins.ts` vs `plugin/host.ts` | Every new `HostMethod` inherited the 5-minute bound |
| Fix stale security prose | `packages/server/src/validate.ts` and the broker's container rationale | These are the comments a reviewer will reason from |
| Test what was untested | `kind: 'component'`, `manifest.command`, sandboxed spawn, plugin-node branching | Both routes to a non-JS plugin — `manifest.command` and an executable entry — had zero coverage |

Two things were finished after the first pass at this phase, and are worth knowing about because
they are the shape of the remaining risk in this area:

- The per-call timeout is **clamped to the run budget** in `server/plugins.ts`, not merely made
  independent of it. A pending plugin call is not interruptible from the runner, so before the
  clamp an operator who lowered `--timeout` to shed load had silently *raised* how long a hung
  plugin could hold a concurrency slot.
- The run's `AbortSignal` is threaded through `remoteNodeDef`/`remoteTransformDef` into
  `PluginHost.call`, which kills the process on abort. Without it, a client that hangs up leaves its
  slot occupied until the per-call timer fires. Phase 2's `cancel` frame is the graceful version of
  this; the kill is the floor underneath it.

**Unblocks:** everything.

### Phase 1 — Capabilities — **landed**

Manifest field + grant/deny in `RemotePluginOptions` + enforcement replacing the hardcoded method
check in `plugin/host.ts`. **No new methods.** The only behaviour change is that `runTool` became
explicitly declared instead of implicitly available.

The enforcement is two stages rather than the single `granted.has()` this document originally
proposed — see §7.3 for why the two messages have to stay distinct.

**Depends on:** Phase 0 (the transform fix, or the gate is inconsistent from day one).
**Unblocks:** every subsequent phase. Nothing that widens `PluginMethod` may ship before this — §7.3.

### Phase 2 — Lifecycle, protocol versioning, and the streaming contract — **landed**

| Item | Where |
|---|---|
| `PROTOCOL_VERSION`, and the rule that compatible means equal | `plugin/protocol.ts`, `spokenProtocol` |
| `init`, written first and never waited for; a mismatch fails the plugin naming both versions | `plugin/host.ts`, `greet` / `checkProtocol` |
| `shutdown` + closed stdin, with SIGKILL armed before either is sent | `plugin/host.ts`, `stopProcess` |
| `cancel`, with the caller's promise rejected first and the kill armed before the frame | `plugin/host.ts`, `abandon` / `cancelRemotely` |
| `RpcPartial`, `isPartial` routing, and the timeout becoming a silence budget | `plugin/protocol.ts`, `plugin/host.ts`'s `progress` |
| `HostLifecycleMethods` / `HostVerbs` / `hostRequest`, so the frames with no caller are still typed | `plugin/protocol.ts` |
| `ctx.signal`, `serve(handlers, { shutdown })`, and the version the runtime answers `init` with | `plugin/runtime-source.ts` |
| `chatCompletionStream?` on `Provider`, `ChatChunk`, `ToolCallDelta` | `llm/types.ts`, `llm/openai.ts` |
| `completeChat` / `collectStream`: stream or buffer, same `ChatResponse` either way | `node/agent.ts`, used by `node/llm.ts` too |
| `token_delta` events, and a `warning` when a failed stream abandons deltas already sent | `runner/events.ts`, `node/agent.ts` |
| `serializeEvent` carrying `delta` — and `message`, which it had silently dropped since it existed | `packages/server/src/sse.ts` |
| `Dependencies.stream`, the operator's opt-out, since no shipped config type reaches the fallback | `node/types.ts`, `node/agent.ts`, `node/llm.ts`; `heddle run --no-stream`, `HEDDLE_STREAM` |

Four decisions differ from what §7.1 and §7.5 proposed — lifecycle verbs kept out of `HostMethods`,
`protocol` rather than `protocolVersion`, no `pluginVersion`, and silence read as version 1. They are
argued where they landed (§7.1), not here.

Three things deliberately did **not** land, and each is a Phase 3+ dependency rather than an
oversight:

- **Nothing in heddle emits a partial yet.** The frame, the routing rule and the `onPartial` consumer
  all exist; no verb produces one. That is the entire point — the shape had to land before third-party
  plugins exist, because adding a frame type afterwards is a flag day, and the consumer side had to
  land with it so `call`'s signature is not what changes once plugins depend on it.
- **`InitParams.seams` is absent.** It describes a middleware registration that does not exist
  (Phase 6). It goes in when there is something to put in it.
- **~~The CLI and the playground do not render `token_delta`.~~ Since drawn.** Both ignored unknown
  event types, so neither broke and neither showed a token. `packages/cli/src/cli/progress.ts` now
  has an arm for it — ungated, because a `heddle run` that prints nothing while a model answers is
  the silence streaming exists to fill — and `RunEvent` carries `delta` with a label in `RunLog.tsx`.
  The rule the entry was written for stands: streaming is a contract, not a feature, until a consumer
  draws it, and Phase 3 met the same problem with `plugin_log`.

**Depended on:** Phase 1 (`init` carries the granted capability set).
**Unblocks:** Phase 5 inherits a settled `Provider`; Phase 9 gets something worth encoding;
cooperative cancellation; every future frame without a compatibility break.

### Phase 3 — `PluginContext` widening — **landed**

| Item | Where |
|---|---|
| `EventType` opened as `BuiltinEventType \| PluginEventType`, so a plugin event cannot spell a builtin however it is named | `runner/events.ts` |
| `pluginEventType`, the only way to mint one — and deliberately **not** exported from `packages/core/src/index.ts`, which is the load-bearing half of the forgery argument: a caller can recognise a plugin event but cannot construct one | `runner/events.ts`, `core/index.ts` |
| `isPluginEvent`, `PLUGIN_EVENT_PREFIX`, and `Event.data` / `Event.level`, all exported for consumers | `runner/events.ts`, `core/index.ts` |
| `PluginReporter`, shared by nodes and transforms so attribution and the name check have one implementation | `plugin/types.ts`, `plugin/executor.ts`'s `pluginReporter` |
| The `emitEvent` and `log` verbs, gated by the same two-stage capability check as `runTool` | `plugin/protocol.ts`, `plugin/host.ts`'s `serveEmitEvent` / `serveLog` |
| `InFlight.call` on every reverse call, so a report is attributed to the call heddle dispatched and a `runTool` runs in that call's tool scope | `plugin/protocol.ts`, `plugin/host.ts`'s `reportingTo` / `runningToolsFor` |
| `ExecuteParams.workspace` and `PluginContext.getWorkspace` — a pushed value, not a verb (§7.2) | `plugin/protocol.ts`, `plugin/types.ts`, `plugin/executor.ts` |
| `serializeEvent` spreading rather than listing, so `data` and `level` reach a client without it being told they exist | `packages/server/src/sse.ts` |
| `plugin_log` and namespaced events rendered by `heddle run`, and by the playground's log | `packages/cli/src/cli/progress.ts`, `website/components/playground/RunLog.tsx` |

Two things deliberately did **not** land:

- **`getWorkspace` is not available to a confined plugin.** Under `--safe` the plugin's process gets a
  sandbox session of its own (`packages/server/src/plugins.ts`) and the node's tool scope is a
  different one; both backends fix confinement when the process is spawned, while the tool scope is
  opened per execution afterwards, so there is no moment at which the node's directory could be bound
  in. heddle sends no path and the plugin's `getWorkspace` fails naming the limitation, rather than
  handing back a path that EPERMs at the first write. The capability gap is real and stated on the
  field: under `--safe`, a plugin node passes a tool its input through `runTool` and nothing else.
- **The chat TUI still ignores plugin events.** `packages/cli/src/chat/ui.tsx` reads four event types
  — `node_start`, `token_delta`, `tool_call`, `tool_result` — and has no arm for `plugin_log` or a
  namespaced type, so a plugin used from `heddle chat` is as silent as it was before. Recorded here
  for the same reason Phase 2 recorded `token_delta`: a contract nothing draws is not yet a feature.

**Depends on:** Phases 1, 2.
**Unblocks:** any plugin that wants to report progress. Also fixes the observability gap where a
plugin node was silent between `node_start` and `node_complete`.
Cost: low.

### Phase 4 — `callModel` — **landed**

| What | Where |
|---|---|
| `callModel` in `PluginMethods` and `SERVED`, with `CallModelParams` and `readModelRequest` — every message checked before it reaches `buildMessages`, because a `Message` interface says nothing about a value parsed out of a pipe | `packages/core/src/plugin/protocol.ts` |
| `PluginModel`, which reads the component's own `llm_config`, memoizes the provider per compiled component, and binds the run's signal per execution; and `toolRunner`, moved here so a node and a transform get one implementation | `packages/core/src/plugin/services.ts` |
| `serveCallModel` — per-component caller, no host-wide fallback; and `Pending.serving`, the clock hold, taken by `runTool` as well | `packages/core/src/plugin/host.ts` |
| `PluginServices`, shared by `PluginContext` and `TransformContext`, so `runTool` and `callModel` are the same set for both | `packages/core/src/plugin/types.ts` |
| `ctx.callModel` in the emitted runtime, and the author documentation for it | `packages/core/src/plugin/runtime-source.ts` |
| The grant policy and the sentence explaining it; `RemotePluginOptions.refusedBecause` | `packages/server/src/plugins.ts`, `packages/core/src/plugin/remote-loader.ts` |
| Seam #26: `ChatRequest` gains the generation parameters, `generationParams` reads the spec field, `buildGeneration` translates at the OpenAI boundary | `llm/types.ts`, `llm/provider.ts`, `llm/openai.ts`, `node/agent.ts`, `node/llm.ts` |

Three things landed differently from this draft, each argued where it lives: the model comes from the
**component's** `llm_config` rather than the run's provider (§7.2); the call is **buffered**, with the
push/pull bridge §7.6 describes left to Phase 5 where it belongs; and the per-call timeout became a
budget heddle **stops charging** while it is the one making the plugin wait.

Two things deliberately did **not** land:

- **`Message` was not widened.** This draft expected it to be. Nothing `callModel` needs is missing
  from it, and adding speculative fields — a `name`, multimodal content — would have put shapes on
  the wire that no caller produces and no adapter reads.
- **A `callModel` cannot stream, and `emitEvent` is not a substitute for one.** A plugin that wants
  to show a model's answer arriving has no way to; it can only report *that* it is working. The gap
  is real and is the same one seam #33's encoder would close from the other end.

One asymmetry was closed on the way past, because leaving it would have deepened it: in process,
`TransformContext` had no `runTool` at all while a remote transform had one. Adding `callModel` to
both and `runTool` to only one would have made "what a component may do" depend on which side of a
process boundary it runs on for a second time — the same defect Phase 0 fixed in `setToolRunner`.

**Depended on:** Phase 1 (mandatory — §7.3), Phase 3 (the serving path).
**Unblocks:** LLM-as-judge, semantic routers, summarizers, self-critique — the largest single class
of plugin people ask for. And Phase 5, whose second prerequisite this was.
Cost: medium, as estimated.

### Phase 5 — Provider kind — **landed**

`kind: 'provider'` — a plugin supplying a custom `llm_config` type, so a spec writes
`component_type: AnthropicConfig` where it would write `OpenAiConfig` and every position that takes a
model configuration takes this one too.

**All three prerequisites are discharged, and two of them were the phase.** `createProvider` was a
directly-imported free function called from three places; every one now goes through `providerFor`
(`llm/provider.ts`), which is the only way anything in heddle turns a config into a `Provider`. That
collapse is what makes a provider plugin one change rather than three, and `Dependencies.createProvider`
is the substitution point the roadmap asked for — it replaces heddle's *own* construction and
deliberately not the registry lookup, so an embedder installing a stub cannot silently switch off
every provider an operator loaded. `LLMExecutor` now memoizes: it used to build a provider per
execution, which would have discarded a plugin's connection pool, token bucket or response cache
between visits to the same node. That was a precondition, not a follow-up, and it is pinned by a
test that runs one executor twice.

**A plugin cannot take a name the SDK ships**, enforced twice on purpose. `PluginRegistry.claim`
refuses a builtin component type at load — that is the message an author gets — and `providerFor`
checks the SDK's `isBuiltinComponentType` *before* it consults the registry, so there is no lookup
for a plugin to win. Either alone would be a rule that holds until someone reorders something.

Two sets are in play and they are not the same, which the review caught: `OPENAI_COMPATIBLE_TYPES`
is what heddle can *build* (four types) and the SDK's builtin map is what a plugin may not *claim*
(everything, including `OciGenAiConfig` — a fifth member of `LlmConfigUnion` heddle has no client
for). Gating the registry on the narrower one left the invariant resting on the two happening to
overlap, and produced an error telling an operator to `--plugin` a type `claim` refuses outright.
Both are consulted now, the SDK's first, and an Agent Spec builtin heddle cannot build is refused as
what it is.

**A provider gets the scopeless `runTool` a transform gets, passed explicitly.** It owns no tool
scope — it is not a node and opened nothing — so a throwaway sandbox session per call is the honest
answer. Passing it rather than leaving `PluginHost`'s host-wide fallback to supply one is the point:
that fallback is whatever `setToolRunner` was first given, so a plugin shipping both a node and a
provider would have run the provider's tools inside *the node's* session and workspace, and the same
provider loaded alone would have got a throwaway one. `callModel` is deliberately absent — a
provider *is* the model, and the config it would call on is itself.

**What crosses to a provider is the config, never the credential.** `deps` holds the operator's
`defaultLlmKey`; `remoteProviderDef` sends the component and the request and nothing else, so it
never reaches an out-of-process plugin. `$VAR` is deliberately *not* resolved on the way either: a
`$VAR` in an `llm_config` means "read heddle's environment", and heddle will not do that on behalf of
a process that `--safe` confined precisely so it could not — the same mistake `ExecuteParams.workspace`
refuses to make with a path.

**The streaming bridge, which this phase owed.** A `Provider` streams by pull; a plugin streams by
push. Three rules make the second presentable as the first, and all three are the protocol's:
each partial is one `ChatChunk`; the call's response *is* the final chunk, so a call that ends
without one is a failed call and never an empty answer; and only a partial restarts the silence
budget, so a provider that declares streaming and then buffers internally is killed exactly like one
that hung. Whether a component streams at all is a manifest field, not a negotiation — `completeChat`
decides by whether `chatCompletionStream` exists, synchronously, before the process is necessarily
running.

| Landed | Where |
|---|---|
| `providerFor`, the single seam; `isBuiltinConfigType`; `Dependencies.createProvider` | `llm/provider.ts`, `node/types.ts` |
| `PluginProviderDef`, the `provider` kind, `registry.providerDef` | `plugin/types.ts`, `plugin/registry.ts` |
| The `chat` verb, `readChatResponse`, `readChatChunk` | `plugin/protocol.ts` |
| `remoteProviderDef` and `pullFrom`, the push-to-pull bridge | `plugin/remote.ts` |
| `kind: 'provider'` and `stream` in a manifest; `ctx.partial` in the inlined runtime | `plugin/manifest.ts`, `plugin/runtime-source.ts` |
| Vendor patch 3: lazy indirection for `LlmConfigUnion` — one registration, four slots | `vendor/agentspec/src/llms/lazy-schemas.ts` and four files it touches |
| `LLMExecutor` memoizes its provider and reads generation params once | `node/llm.ts` |
| Four test files off `vi.mock('llm/provider.js')` and onto `Dependencies` | `node/__tests__`, `plugin/__tests__` |

**One inconsistency this surfaced and fixed.** `default_generation_parameters` holds a plain object,
and which case its *keys* arrive in depends on who deserialized the config around it: the SDK
camelCases the fields of a schema it knows, so a builtin yields `maxTokens`; heddle's plugin
deserializer hands nested plain objects through untouched — `loadField` treats them as user data — so
a plugin provider's config yields `max_tokens`. The author wrote `max_tokens` either way, so
`generationParams` now reads both spellings. Reading one would have silently dropped a token ceiling
on exactly the configs heddle knows least about.

**Unblocks:** Anthropic/Bedrock, record-replay CI, retry and caching wrappers (seam #2).

**Not done, and deliberately.** A provider plugin's network access is still ungoverned — §7.10 Q4 —
and this phase makes that question concrete rather than hypothetical, since a provider is the one
kind whose whole job is an outbound request. A submitted provider is *not* refused by the server the
way middleware is: it runs only when the caller's own spec names it, it cannot capture a builtin
type, and heddle bounds how often it is called — which is more than can be said for `callModel`.

### Phase 6 — Middleware kind — **landed at `nodeError`; five seams reserved**

The advice held: `nodeError` alone, and the cost estimate held too — restructuring `runner.ts:61-73`
was the easy part, and the policy questions were the phase.

| Landed | Where |
|---|---|
| `middleware` as a fourth `ComponentKind`, kept out of `componentTypeNames()` because no spec may name one | `plugin/registry.ts` |
| The `SEAMS` table: position, halves, `when`, admitted verdicts, `implemented` — read by the manifest validator, the verdict reader and `init` | `plugin/seams.ts` |
| `MiddlewareChain`: reverse registration order, first non-`pass` wins, `MiddlewareError`, the 30 s delay clamp | `plugin/middleware.ts` |
| The seam itself: an attempt loop via `continue`, `maxNodeAttempts`, `Event.attempt`, `warning` per granted retry and per substituted result | `runner/runner.ts`, `runner/options.ts`, `runner/events.ts` |
| The `after` verb, `AfterParams`, `readAfterVerdict` checked against the seam | `plugin/protocol.ts` |
| `seams` declared in the manifest, refused four different ways | `plugin/manifest.ts` |
| `remoteMiddlewareDef`, with its own tool runner so capability does not depend on load order | `plugin/remote.ts` |
| One configuration channel: `--plugin-config <Type>=<json\|@file>` into `MiddlewareChain.build`, checked there by the def's own `validateConfig`, with a key no middleware claims refused | `cli/run.ts`, `plugin/middleware.ts`, `plugin/remote.ts` |
| `readSubscription` shared by the manifest and the in-process path, so an author cannot subscribe to an unconsulted seam or a half that does not exist on either | `plugin/seams.ts` |
| Seam-keyed handlers and `ctx.component` in the emitted runtime | `plugin/runtime-source.ts` |
| A spec naming a middleware refused with the reason; a *submitted* middleware refused 400 | `plugin/flow-preprocess.ts`, `server/plugins.ts` |

**What deliberately did not land.** `before` — with `modify` and `reject` — is unbuilt, because
nothing subscribes to one yet and a verdict vocabulary with no call site is a contract nobody can
test. The names are reserved in `SEAMS` so `node`'s arrival changes no meaning.

**And what an operator cannot do yet, stated rather than papered over: the server installs no
middleware.** It has no operator-plugin path at all — `buildPlugins` loads only what a request
submitted — so building one is its own change (startup manifest loading, per-run instantiation,
sandbox sessions, disposal) and is not this phase. What the server does today is refuse a *submitted*
middleware, which is the half that had to land with the kind rather than after it. Middleware is
therefore reachable from the CLI and from an embedder holding `RunnerOptions`, and not from
engine.heddle.run.

One smaller gap worth knowing about. `heddle chat` builds its own `Runner`
(`packages/cli/src/chat/ui.tsx`) from the same options object, so the chain *is* installed there and
a retry works — but the TUI reads four event types and has no `warning` arm, so the retry happens
silently. `heddle run` renders it, via `cli/progress.ts:55`. Recorded for the same reason Phase 3
recorded the TUI's silence about `plugin_log`: a contract nothing draws is not yet a feature.

**Depends on:** Phases 1, 2, 3.
**Unblocks:** retry and fallback today; approval gates, caching, dry-run and result truncation when
`toolCall` and `node` land against the shape this phase fixed.

### Phase 7 — Registry / tool-source — **landed**

A plugin contributes tools two ways, and exactly one per entry: `path`, an executable it ships beside
itself, or `componentType`, a tool it implements behind the `callTool` verb. The first runs through
`SubprocessExecutor` indistinguishably from a `--tools-dir` tool; the second needs no tools
directory, no subprocess and no execute bit at all.

**`ToolDef.path` became `ToolDef.impl`**, a discriminated union, and that was the load-bearing
change. Four call sites each spelled `executor.execute(signal, toolDef.path, input)` — `node/agent.ts`,
`node/tool.ts`, `plugin/executor.ts`, `plugin/services.ts` — and four copies of a decision are
survivable only while there is one answer. They now call `invokeTool` (`tool/invoke.ts`), which
branches once. The obvious repair, an optional `path` beside an optional `call`, was rejected: two
fields both claiming how a tool runs leave every consumer to rediscover the precedence.

**Dynamic `listTools` deliberately did not land, and open question 6 is answered no for now.** The
property `remote-loader.ts` protects is that nothing executes to learn what a plugin provides, and
`Registry.lookup` is synchronous at three call sites including the server's request check. Declared
tools keep both. An MCP proxy writes its tool list into the manifest with a build step, which costs a
rerun when a tool is added upstream and buys a `heddle validate` that still starts nobody's process.

| Landed | Where |
|---|---|
| `ToolImpl` union and the single `invokeTool` dispatch | `tool/types.ts`, `tool/invoke.ts` |
| Manifest `tools[]`: name rule, `path` xor `componentType`, schema byte/depth/type caps | `plugin/manifest.ts` |
| A tools-only manifest loads; `--plugin ./mcp.json` reads one on the CLI | `plugin/manifest.ts`, `plugin/loader.ts` |
| `PluginRegistry.toolRegistry()`, and a load error when two plugins claim one name | `plugin/registry.ts` |
| `composeRegistries` and `missingTools` moved into core; a plugin-vs-other collision is refused unless the manifest declared `shadows` | `tool/registry.ts` |
| The registry fills a description or schema the spec left blank; the spec wins, with a warning on disagreement | `node/agent.ts` |
| An input with a `default` is no longer required — and the default is applied when the model omits it | `node/agent.ts` |
| Plugin tool directories join the sandbox `readPaths`; `run` and `validate` check the merged registry | `cli/run.ts`, `cli/validate.ts` |
| A submitted manifest declaring `shadows` refused 400 | `server/plugins.ts` |

**What the adversarial review changed.** Eight defects, three of them found independently by three or
four reviewers. The two that mattered: `entryFor` derived the plugin's root from `command[0]`, so a
manifest saying `["/usr/bin/python3", "server.py"]` — the ordinary shape — put the spawn cwd and the
tool-containment root under `/usr/bin`, refusing the plugin's own tools and admitting any system
binary; and the CLI never disposed the plugin registry, so `heddle run --plugin x.json` printed its
result and then hung forever, because `loadPlugins` was a new `addRemote` caller and only the server
had ever had something to dispose.

Also from it: `shadows` was validated, documented and never consulted, so the rule three comments
described did not exist — it is enforced in `composeRegistries` now, in both directions, because
losing a name matters as much as taking it. A directory passed the executable check, since a
directory carries the execute bit for being traversable. The tool-name collision guard had an escape
hatch two plugins could walk through by reporting the same manifest name. `heddle validate`'s new
tool check sat inside a `catch` that downgrades everything to a printed note, so it could not fail
the command. And `ctx.log` was offered to a tool handler that has no reporter, so it would have been
refused every single time — removed rather than half-wired.

**Unblocks:** MCP tool discovery through a proxy plugin, HTTP tool catalogues, single-source-of-truth
tool descriptions.
Cost: low as predicted for the manifest half; the union refactor was the real work.

### Phase V — Vendored SDK extension (formerly Phase 8) — **landed**

**Tier 1** exported `registerNodeUnionSchema` and `registerFlowSchema` and nothing called them, so
`NodeUnion` stayed closed in practice. **Tier 2** calls the seam, adds the matching one for
`MessageTransformUnion`, and deletes the placeholder machinery both existed to replace. Net −200
lines.

**The registration knows nothing about which plugins are loaded, and that is the design.** The
obvious implementation — register `NodeUnion` widened with *this run's* plugin schemas — cannot be
made safe: `registerNodeUnionSchema` writes a module-global that `z.lazy()` reads at parse time, and
heddle builds a `PluginRegistry` per request with concurrent runs in one process. Save-and-restore
around a synchronous parse works today and only today; its correctness rests on no `await` ever
appearing between the write and the restore, which is invisible, untyped, and one refactor from a
caller's flow validating against a different caller's plugin set — a failure that would not crash,
only quietly accept. So the widened schema asks one question, *is this `componentType` builtin*,
whose answer is a frozen-table lookup identical in every run forever (`spec/open-unions.ts`).

**What it gives up is slot discipline**, which the union was enforcing for free and can no longer:
it cannot tell a plugin's node from a plugin's transform without knowing the plugin. Three checks
take it over, and each names the kind — `toSpecNode`, `TransformChain.build`, and the compiler's
default branch. That trade is favourable: `Invalid discriminator value` listing every builtin node
type became "which a plugin provides as a transform rather than a node".

**What it does not give up is anything about builtins**, and this is pinned rather than asserted: the
same malformed document was parsed with the change stashed and unstashed, and the error is
byte-identical.

| Landed | Where |
|---|---|
| The widened unions, registered once, idempotent | `spec/open-unions.ts` |
| Vendor patch 2: lazy indirection for `MessageTransformUnion`, defaulting to `z.never()` so a half-applied patch is loud | `vendor/agentspec/src/transforms/lazy-schemas.ts` and three files it touches |
| `flow-preprocess.ts` reduced from substitution to `checkPluginComponents`, which reports and rewrites nothing | `plugin/flow-preprocess.ts` |
| The restore path deleted; `AdapterOptions` down from three fields to one; `toSpecNode` gains a kind-aware branch | `spec/adapter.ts` |
| One SDK deserialization per document instead of one per plugin component plus one for the rewrite | `spec/parser.ts` |

**`LlmConfigUnion` and `ToolUnion` deliberately stayed closed.** Phase 4 already showed why: a plugin
component's fields are never zod-parsed, so an ordinary `llm_config` on a plugin node deserializes
today and `callModel` works with zero union involvement. Widening `LlmConfigUnion` buys exactly one
thing — a *custom* config type in a *builtin* slot — which is Phase 5's provider kind and should be
argued there with a caller in hand. Tier 1 is the standing evidence for what an unused registration
seam is worth.

**Unblocks:** Phase 5 at its lower cost. Every future component kind's placeholder cost is now zero.

### Phase 9 — Encoder kind — **landed**

`kind: 'encoder'` (§7.9), selected per request rather than named in a spec, with AG-UI as the first
implementation and heddle's current frames re-expressed as the builtin one. The cost estimate held —
the rendering itself is small — and the two things that were not in the estimate are worth naming,
because both were consequences of the kind rather than of the protocol.

**The engine's event handler is synchronous and an out-of-process encoder is not.**
`EventHandler` returns `void` and `Runner.emit` is fire-and-forget, so nothing in the engine could
await a rendering that answers over a pipe. That is `EncoderStream`: a queue and one loop, the mirror
image of Phase 5's `pullFrom` — there a plugin pushed and a `Provider` pulled, here the engine pushes
and an encoder may answer whenever it answers. Without it, calling `encode` per event would put a
remote encoder's round trips in flight together and let two frames whose order a protocol depends on
race each other. Every run now goes through it, including `?protocol=heddle`, which is why the first
server test asserts the default frames are byte-for-byte what they were.

**A run had no identity.** Nothing in the engine or the server had ever needed a name for one — the
broker mints a `runId`, and the broker was never deployed. AG-UI's `RUN_STARTED` requires `threadId`
and `runId`, so the server mints one per request and hands it to `createEncoder`. It is the request's
identity rather than the graph's, which is why it lives there and not in the runner.

**Depends on:** ~~Phase 2 (token streaming)~~ — satisfied: `token_delta` exists, so AG-UI no longer
degrades to a single `TextMessageChunk` carrying the whole answer. ~~Phase 3 (a namespaced
`EventType`)~~ — satisfied. ~~The message-boundary decision in §7.9~~ — decided: it is the encoder's,
and heddle emits nothing, for the reason given there.

**`Event` is versioned, as this phase was told to do.** `EVENT_CONTRACT_VERSION` is an integer beside
`PROTOCOL_VERSION`, sent at `init` as `events`, and reported on `/v1/capabilities`. It differs from the
protocol version in one deliberate way: a mismatch is *not* a refusal. A plugin speaking the wrong
protocol cannot be talked to at all; an encoder reading a later event contract still renders every
field it recognizes, so refusing the run would trade a complete rendering for none. Adding a field
does not move the number, and `serializeEvent` spreading rather than enumerating is what makes that
direction safe.

While there: the test §10 calls "the only form of this that survives someone adding a field in a
hurry" had stopped covering one. `FULL` in `server/__tests__/sse.test.ts` is walked with
`Object.keys`, so a field missing from the literal is a field unchecked — and `attempt` was never
added when Phase 6 added it to `Event`. It is now typed `Required<Event>`, so omitting one is a
compile error rather than a quietly narrower guarantee.

**Unblocks:** CopilotKit and any AG-UI client against a heddle flow with no adapter in between;
OpenAI-compatible chunk output; OTLP span export from the same event stream.

---

## 10. Risks and non-goals

### Compatibility surface

`HeddlePlugin` and friends are exported from `packages/core/src/index.ts`, so they are public
API. Adding optional fields (`capabilities`, `seams`, `providers`) is safe. Changing
`PluginNodeDef.createExecutor`'s signature (`plugin/types.ts`, `PluginNodeDef.createExecutor`) is not, and the shipped
`examples/guardrails/plugin.js` is a live consumer of the in-process shape — the examples test loads
it for every example that ships one.

Separately: the two authoring APIs are already not feature-equivalent (§3.3), and every phase widens
the gap. Either the in-process API gets the same additions, or its narrower scope becomes explicit
documentation rather than an accident.

Two new contracts appear in this revision and both are easy to create by accident:

- **~~`Event` becomes public the moment encoders exist~~ — it did, and it is versioned** (§7.9).
  `Event` and `EventType` have been exported from `packages/core/src/index.ts` since before Phase 3,
  and Phase 3 added `data`, `level`, `isPluginEvent` and `PLUGIN_EVENT_PREFIX` to that surface — so
  third-party code could already consume the shape. Phase 9 made a third party *render* it, and
  discharged this paragraph's instruction in the same change: `EVENT_CONTRACT_VERSION` is an integer
  beside `PROTOCOL_VERSION`, sent to every plugin at `init` as `events` and reported on
  `/v1/capabilities`. Adding a field does not move it; changing or removing one does. A mismatch is
  not a refusal — see the constant for why a partial rendering beats no rendering, which is the one
  place the two version numbers deliberately behave differently.

  Phase 2 found the sharp edge on the way there, and it is worth naming because every phase that adds
  an event will meet it. `serializeEvent` used to copy a **fixed list of fields**, so a field added to
  `Event` and not added there was dropped with no type error and no warning: the engine emits it, the
  browser never sees it, and nothing anywhere says so. `message` had been in exactly that state since
  the function was written, which meant every `warning` frame reached clients empty. It now spreads
  instead of listing — which is how Phase 3's `data` and `level` reached clients without it being
  told they exist — and is covered by a test that walks a fully-populated `Event` and asserts nothing
  is missing (`packages/server/src/__tests__/sse.test.ts`).

  **That test had itself gone quietly narrower, and the way it did is the lesson.** It walks
  `Object.keys(FULL)`, so its coverage is whatever the `FULL` literal happens to list — and `attempt`
  was added to `Event` in Phase 6 and never added there. For two phases it enumerated fifteen of
  sixteen fields and reported success, which is the *same* failure mode as the fixed list it was
  written to catch, one level up. Phase 9 typed it `Required<Event>`, so a field added to `Event` and
  not added here is now a compile error. A test that guards an enumeration has to be exhaustive by
  construction, or it is an enumeration too.
- **A patched `vendor/agentspec` is a fork** (§8.1). It is a cheap one — the package is unpublished
  and bundled via `noExternal`, so there is no downstream consumer — but the refresh workflow in
  `VENDOR.md` assumes a verbatim copy and will silently revert the patches if it is followed as
  written. The bookkeeping change is part of the work, not a follow-up.

### A hook that runs on every node can break every flow

This is the sharpest new risk and it has no precedent in the current design. A `transform` only
affects agents that declare it (`plugin/transform.ts`, `TransformChain.build`). A middleware on `node` affects
**everything**, including flows written before the middleware existed and by people who have never
heard of it. A middleware that throws at `runner.ts:61` fails runs it has nothing to do with.

Mitigations, all of which should ship *with* Phase 6 and not after:

- Seams are declared per component in the manifest, so the blast radius is inspectable as data
  before anything runs — the same property `manifest.ts:1-19` already buys.
- An error policy, decided rather than defaulted (§7.10 Q3).
- A middleware may not introduce a branch: `graph/validate.ts:26-51` checks reachability before
  execution, and `plugin/executor.ts`'s `runNode` branch check already enforces the analogous rule for nodes.
- A `replace` verdict is reported as a `warning` event, so "the flow returned something odd" is
  traceable to the middleware that did it.

### Performance of per-call IPC

`runner.ts:61-62` costs one `await` today. With two middlewares on the `node` seam it costs four JSON
Lines round trips through a pipe, plus four full serializations of the node's `State` — and
`plugin/remote.ts`'s `serializable` already does a complete `JSON.parse(JSON.stringify(...))` round trip of the
component's spec fields once per compiled node (`remote.ts`, `createExecutor`), on top of the per-call framing in
`encode` (`protocol.ts`, `encode`). A 20-node flow with two middlewares is 80 round trips carrying the accumulated
state each time, and `State.merge` is a shallow spread that only grows (`state/state.ts:36-38`).

`modelCall` and `toolCall` middleware are less alarming because the underlying operation is already
network- or process-bound. `node` middleware on a fast graph is the case that will hurt. Two
defences worth designing in from the start: per-seam registration so a plugin is only asked about
seams it declared, and a `subject` payload that carries references rather than the whole state where
the seam permits it.

**An out-of-process encoder is the worst case on this axis, and Phase 9 shipped it knowingly.** A
middleware costs a round trip per node per seam; an encoder costs one **per event**, and the event
heddle emits most is `token_delta` — one per fragment of every model answer. A streamed
thousand-token reply is therefore on the order of a thousand JSON Lines round trips through a pipe,
each carrying a few bytes of text, to render frames that are themselves a few bytes. Nothing in the
engine is waiting on any of them, which is the saving grace: `EncoderStream` queues, the run proceeds,
and the cost is latency on the client's stream plus CPU on the server rather than a slower flow. The
bound is the run's own wall-clock budget.

The defences, in the order they should be reached for. **A batched verb** — `encode` taking the
events queued since the last call rather than one — is the obvious one and needs no new concept:
`EncoderStream` already holds exactly that list, and the frames come back in the same order either
way. **An in-process encoder** is the other, and it is free: `PluginEncoderDef` is an ordinary
in-process interface, so an operator's own encoder costs a function call. What is not a defence is
declaring which events an encoder wants, which looks appealing and is a `serializeEvent` field list
wearing a manifest — a filter that has to be updated whenever an event is added, failing silently
when it is not. Neither is built, because the first consumer is a client submitting an encoder for its
own run and paying its own latency, and a batching change is one an ordinary profile will justify
better than this paragraph can.

### What stays closed, and why

| Closed | Where | Why |
|---|---|---|
| `State` as a replaceable type | `state/state.ts`; `NodeExecutor` is typed against the concrete class (`node/types.ts:7`) | A merge-*policy* slot (seam #17) gets the value at one call site (`runner.ts:89`). Replacing `State` wholesale touches every executor for no proportionate gain. |
| Sandbox confinement moving out of the executor | `sandbox/types.ts:1-8` | The design's whole point is that nothing in the graph, node or spec layers knows a sandbox exists. Per-tool *policy* (seam #29) is reachable without breaking that. |
| Prototype-pollution key filtering | `plugin/deserializer.ts:50,124-126` | Applied both before and after camelCasing, on a path that parses caller-supplied JSON. Not negotiable. |
| Builtin type shadowing | `plugin/registry.ts:77-83` | Only with an explicit `implements: "builtin"` opt-in and a stated precedence rule (§7.10 Q7). The default stays: a plugin cannot silently become `AgentNode`. |
| `$VAR` dereference for submitted specs | `llm/provider.ts:32-53` | The reference is not restricted to model credentials, and the "is not set" error is an enumeration oracle. |
| Plugins in the server's process | `packages/server/src/plugins.ts:9-18` | Everything above is designed *around* this constraint. If a proposal is easier in-process, that is a reason to reject the proposal. |
| Environment inheritance | `PluginHost.resolveCommand` (`plugin/host.ts`, `resolveCommand`), `packages/server/src/plugins.ts` | Named capabilities grant heddle-mediated *operations*, never raw process access. There is no `getEnv`, and there should not be one. |
| An encoder that can alter the run | §7.9; `plugin/types.ts`, `PluginEncoder` | `Event → WireFrame[]` is one-directional on purpose. An encoder renders what happened; giving it a return path would make it middleware with none of §7.4's ordering rules, and a rendering layer that can change the thing it renders is not a rendering layer. Held after Phase 9, and it paid: AG-UI's mutually exclusive terminal events forced the example to *infer* the outcome from the stream, which works because `flow_complete` is emitted only on success. The one place an encoder does affect the run is by failing — the stream and the run end together — and that is the transport reporting a broken response, not a verdict. |
| A plugin answering for heddle's own protocol | `plugin/registry.ts`, `claimProtocol`; `server/encoders.ts`, `resolveEncoder` | `?protocol=heddle` is a client asking for the frames heddle documents, and a browser written against `flow_complete` is switching on them. Refused at load *and* unreachable by lookup order, which is the same two-sided guarantee Phase 5 gave a builtin `llm_config` type. |
| Divergence from the Agent Spec *format* | §8.1 | Extending the SDK's unions is in scope; inventing fields or semantics that make a heddle spec unreadable to another Agent Spec implementation is not. Every patch should be one upstream would plausibly accept. |
