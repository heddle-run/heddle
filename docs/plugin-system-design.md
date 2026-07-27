# Plugin System: Design and Extension Roadmap

All paths are relative to the repository root. Line numbers are against the tree at the time of
writing; every claim below was read out of the file it cites.

> **Status.** This document was written against the tree *before* Phase 0, and lands in the same
> commit as the work it describes. Phases 0, 1, 2 and V tier 1 are done; §9 marks what remains inside
> each. The surveys in §3 and the "today" snippets in §7 have been brought forward to match, so a
> passage in the present tense describes the tree as it now is. Everything from Phase 3 onward is
> still a proposal — and where Phase 2 landed differently from what §7.1 and §7.5 proposed, the
> proposal has been replaced by what was built, not annotated alongside it.

---

## 1. Goal

**Every decision the engine makes on a flow's behalf should be replaceable or interceptable by
code heddle did not compile in, running in its own process, under the isolation the current
plugin path already provides.**

Concretely, "any part of the agent" means the list the engine currently hardcodes: which provider
answers a model call, what happens when a node throws, whether a tool call is allowed to proceed,
how a tool's result is serialized back into the conversation, how state merges between nodes, how
a prompt template renders, which tools exist at all, and what the run looks like on the wire. Today
none of these are reachable from a plugin — the plugin surface is three component kinds and three
RPC verbs.

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
Runtime of choice" — is heddle. `packages/core/src/plugin/types.ts:4-8` already says this in the
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
| `node` | `createExecutor(node, deps) -> { execute(input, ctx) }` (`plugin/types.ts:132-143`) | `inputs`, `outputs`, `branches`, `schema` (`manifest.ts:32-48`) | `execute` (`plugin/remote.ts:75-79`) | `graph/compile.ts:77-80` → `PluginNodeAdapter` (`plugin/executor.ts:14`), result becomes the node's output `State` (`plugin/executor.ts:83`) |
| `transform` | `createTransform(component, deps) -> { apply(messages, ctx) }` (`plugin/types.ts:122-129`) | `phase`, `schema` (`manifest.ts:48-50`) | `apply` (`plugin/remote.ts:115-120`) | `TransformChain` (`plugin/transform.ts:63-109,131-179`) around the model call at `node/agent.ts:125` (pre) and `:158-162` (post) |
| `component` | `validate?(component)` only (`plugin/types.ts:75-83`) | `schema` | **none** | **none** |

**`kind: 'component'` does nothing at runtime.** `remoteComponentDef` returns `{ componentType }`
plus at most a `validate` (`plugin/remote.ts:135-141`). `nodeDef` and `transformDef` both return
`undefined` unless the kind matches (`plugin/registry.ts:131-141`), so a `component` is unreachable
from `graph/compile.ts:77` and from `plugin/transform.ts:74`. `flow-preprocess.ts:128-130` leaves it
in the document with no stand-in, on the stated grounds that it is "deserialized with their parent".

That is the whole contract, and it is narrower than it looks: a `component` survives *only* because
its parent node or transform was replaced by a stand-in and therefore removed from the document the
SDK validates. Put one in a builtin slot — `Agent.tools`, `Agent.llmConfig` — and the closed union
rejects it before any plugin code runs. Nothing documents that constraint, and there is no test for
`kind: 'component'` end to end.

### 3.2 The RPC verbs

```ts
// packages/core/src/plugin/protocol.ts — as landed
export interface HostMethods          { execute: ExecuteParams; apply: ApplyParams }
export interface HostLifecycleMethods { init: InitParams; shutdown: ShutdownParams; cancel: CancelParams }
export interface PluginMethods        { runTool: RunToolParams }
```

`ExecuteParams` carries `{ componentType, node, input }`; `ApplyParams` carries
`{ componentType, component, phase, messages }`; `RunToolParams` carries `{ name, input }`. Framing is
JSON Lines with direction decided by shape — a message with a `method` is a request, one with a
`partial` is progress on a call that has not finished (`isPartial`), and anything else is a response.

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
all take the component in the in-process API (`plugin/types.ts:124,134-141`); the remote adapter
collapses them to constants (`plugin/remote.ts:92-94,108`). Anything whose shape depends on its own
configuration is not expressible out of process — including the shipped guardrails plugin, whose
`phase` is read from a spec field (`examples/guardrails/plugin.js:136`).

`manifest.command` (`manifest.ts:62`, resolved at `remote-loader.ts:90-98`) is one of two routes to
a non-JavaScript plugin — the other being an executable entry point with a shebang, invoked by path
(`defaultCommand`, `remote-loader.ts:56-74`), which is the form the loader prefers under `--safe`
(`remote-loader.ts:41-55`). `manifest.command` is needed only when the entry point cannot be made a
self-contained executable — the `python3 plugin.py` case named at `sandbox/types.ts:64-67`. Both
routes are the justification for JSON Lines (`protocol.ts:5-7`). Both are now covered — a shell
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

The whole model is the process boundary, argued at `packages/core/src/plugin/host.ts:1-22`.

| Control | Where | Note |
|---|---|---|
| Chosen, not inherited, environment | `PluginHost.resolveCommand` → `env: launch.env` (`plugin/host.ts:352`, defaulted at `:484`) | The server passes literally `env: {}` — `packages/server/src/plugins.ts:40`, with the reasoning at `:33-39` |
| Lazy start | `loadRemotePlugin` reads only the manifest; the process starts inside `PluginHost.call` (`host.ts:202-222`) | Parsing and validating a flow executes zero lines of the author's code |
| Optional sandbox | `host.ts`'s `resolveCommand`; wired at `server/plugins.ts` | Covered by "spawning a plugin under a sandbox" in `plugin/__tests__/remote.test.ts`, against a stub `SandboxSession` — the whole `SandboxCommand` crosses, not just its argv |
| Per-run registry | `server/runs.ts:157`, disposed in `finally` at `:175` | Plus `rmSync` of the run's mkdtemp dir (`server/request-code.ts:239-240`) |
| Teardown that cannot be declined | `dispose` → `stopProcess` (`host.ts`) | `shutdown` then a closed stdin, then SIGKILL. The kill is armed *before* either is sent and only the process actually ending disarms it, so a plugin that ignores both dies as it always did, `SHUTDOWN_GRACE` later |
| Source is never imported | `server/request-code.ts:277-280` | Written `0500` with an absolute `#!node` shebang; the interpreter is absolute because the plugin's env has no `PATH` |
| No `$VAR` deref in submitted specs | `server/runs.ts` → `provider.ts:32-53` | See §7.3 |
| Bounded stderr | `host.ts:369-370` (`STDERR_LIMIT`) | A logging loop cannot grow the server's heap |
| Only `runTool` is served | `host.ts`, `serve()` | Two stages, kept separate on purpose: "heddle does not serve X. It serves: …", then "X is not granted to this plugin". A missing runner is a third message, about heddle's own wiring |

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
| Custom transform | yes | yes | yes | `plugin/transform.ts:74` |
| Custom sub-component | nominal | only under a plugin parent | n/a — never executed | `plugin/remote.ts:135-141` |
| Custom tool *type* | no | — | — | `ToolUnion` closed; `registry.claim` forbids builtin names (`plugin/registry.ts:77-83`) |
| Custom LLM provider | no | — | — | `llm/provider.ts:10-15,122,141` |
| Custom tool source / registry | no | — | — | `Registry` is an interface (`tool/types.ts:44-47`) with no plugin route |
| Custom wire protocol / encoder | no | — | — | `serializeEvent` (`packages/server/src/sse.ts:19-34`) is a free function with one hardcoded rendering |
| Any interception | no | — | — | §5 |

---

## 4. The ceiling

Suppose you add `kind: 'provider'` to `manifest.ts:31` and let it through the validator at `:123-128`.
What happens next:

1. `remote-loader.ts:121-133` has a three-arm switch with nowhere to put it. Add a fourth arm — it
   pushes into… what? `HeddlePlugin` has exactly `components`, `nodes`, `transforms`
   (`plugin/types.ts:151-153`).
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
   (`protocol.ts:80-87`).** There is no verb that means "answer a chat completion". Add one.

Steps 1–4 are plumbing. Step 5 is the ceiling: **a new manifest kind expands what a plugin can *be*;
it does nothing about what a plugin can *do* while running.** Those are two independent axes, and the
protocol only widens on one of them at a time.

| Axis | Type | Today | What widening buys |
|---|---|---|---|
| What a plugin can **be** | `HostMethod` — heddle calls the plugin | `execute`, `apply` | New kinds. Each new kind needs a verb, a dispatch arm, an engine call site, and (usually) a placeholder. |
| What a plugin can **do** | `PluginMethod` — the plugin calls heddle | `runTool` | New *abilities* for kinds that already exist. A node that can `callModel` is a new class of node with no new kind, no placeholder, and no SDK involvement. |

The second axis is dramatically cheaper and is currently at one method. A plugin node cannot emit an
event (`PluginContext` is `{ signal, node, runTool }`, `plugin/types.ts:55-64`), cannot call a model,
cannot log through heddle, cannot reach the sandbox workspace, and cannot read run-scoped state. It
can compute and it can run a tool. That is the real constraint on what people can build, and no
number of manifest kinds relieves it.

There is a second-order trap here. `PluginHost.setToolRunner` is first-writer-wins
(`plugin/host.ts:180-200`) and is called from `createExecutor` (`plugin/remote.ts:71`), which runs
once per node. The comment at `setToolRunner`'s own doc block justifies this because every executor in one compile
shares the same registry — true today, and false the moment per-node registries or per-node policy
exist. And because the transform branch never calls it at all (`plugin/remote.ts:110` drops the
`deps` parameter the interface declares at `plugin/types.ts:125-128`), a transform's `runTool` works
or fails depending on whether an unrelated plugin node happened to run first. **Capability currently
depends on graph structure.** Any capability model has to fix that before it can mean anything.

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

And line 72 is unconditional: **every node error is fatal, and heddle has no error-handling
extension point of any kind.** `EventHandler` returns `void` (`runner/events.ts:53`) and the emit at
`:66` cannot influence the throw. `grep -rn 'retry\|backoff' packages/core/src` finds nothing. A
transient 429 from a tool ends the run.

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

`TransformChain.apply` (`plugin/transform.ts:131-179`) returns `pass | modify | reject`
(`plugin/types.ts:97-102`) and that return value genuinely changes control flow: a `pre` rejection
skips the model call entirely (`node/agent.ts:125-128`), which is why the playground can demo
guardrails with no credential.

So the mechanism is proven in this codebase. Its limitation is the **number of taps**: exactly two,
both outside the tool loop (`agent.ts:125`, `:158`). A transform never sees a tool call, a tool
result, a tool error, or a round boundary. **Adding taps to a proven mechanism is a smaller change
than inventing one**, and the verdict vocabulary should stay recognisably the same.

---

## 6. Seam inventory

Difficulty: **S** = the interface already exists, one call site; **M** = one function to restructure,
a handful of call sites; **L** = touches the protocol, the event system, or the SDK.

| # | Seam | Location | What an author wants | Shape | Diff |
|---|---|---|---|---|---|
| 1 | Provider selection | `llm/provider.ts:10-15,122,141` | Anthropic/Bedrock provider; record-replay provider for free deterministic CI | component | S |
| 2 | Provider wrapping | `llm/provider.ts:141`; no `Dependencies` field (`node/types.ts:12-49`) | retry+backoff, response cache, rate limit, audit log, PII redaction | middleware | S |
| 3 | Node dispatch | `runner/runner.ts:61-62` | per-node timeout, memoization, dry-run, approval gate | middleware | M |
| 4 | Node error | `runner/runner.ts:63-73` | retry, route to a fallback node, degrade to a canned answer | middleware | S |
| 5 | Tool call | `node/agent.ts:190-249` | deny, rewrite args, return cached result — this is `humanInTheLoop` | middleware | M |
| 6 | Tool result | `node/agent.ts:214` | truncate/summarize a 2 MB blob before it eats the context window | middleware | S |
| 7 | Tool error | `node/agent.ts:242-246` | retry a 429 instead of narrating it to the model | middleware | S |
| 8 | Agent termination | `node/agent.ts:155`; `finish_reason` unread (`llm/openai.ts:41`, and in `collectStream`) | stop on truncation; stop when a `submit_answer` tool is called | middleware | S |
| 9 | Output shaping | `node/agent.ts:168-175` | enforce declared `outputs` as a schema; repair non-conforming answers | middleware | S |
| 10 | Round cap | `node/agent.ts:21` | a research agent needing 40 rounds; partial results instead of `:251` throwing | config, not a plugin | S |
| 11 | Tool registry | `tool/types.ts:44-47`; only `FileRegistry` | MCP discovery, HTTP tool catalogue, inline spec tools | component | S |
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
| 24 | Event emission | `runner/events.ts:53`, 9 emit sites | any two-way hook at all; and `EventType` (`:4-13`) is closed so a plugin cannot even emit | protocol | M |
| 25 | Plugin context | `plugin/types.ts:55-64`; built at `plugin/executor.ts:51-55` | `callModel`, `emitEvent`, workspace handle — all already in `deps` at the call site | protocol | S |
| 26 | Generation params | `spec/types.ts:24` unread; `ChatRequest` (`llm/types.ts:30-34`) | temperature, max_tokens, JSON mode, seed. **No spec can set any of these today** | data widening | S |
| 27 | Streaming | ~~absent from `Provider`~~ **landed, Phase 2**: `chatCompletionStream?` (`llm/types.ts`), `llm/openai.ts`, `token_delta` (`runner/events.ts`) | token-by-token rendering | protocol | L |
| 28 | Sandbox backend | `sandbox/index.ts:7,50-68` | Docker/gVisor for the playground; a recording no-op for CI | component | S |
| 29 | Sandbox policy | global at startup (`server/runs.ts:74-77`) | "fetch needs network, file-writer must not" — unexpressible | middleware | M |
| 30 | Spec format / source | `spec/parser.ts:21,71`; `spec/load.ts:13-15,22` | TOML, a DSL; load from a URL or a git ref | component | S |
| 31 | Builtin override | `plugin/registry.ts:77-83`; skip list `plugin/transform.ts:19-22` | ship a real `MessageSummarizationTransform`; "AgentNode with retries" | precedence rule | M |
| 32 | Placeholder slots | `plugin/flow-preprocess.ts:32,39,107,118` | **the ceiling on every "component" row above** | vendored SDK | M |
| 33 | Wire protocol / event encoding | `serializeEvent` (`packages/server/src/sse.ts:19-34`), `SseStream.send` (`:60-63`) | render a run as AG-UI, OpenAI-compatible chunks, or OTLP spans instead of heddle's own frames | encoder | S |

### Ranked shortlist

1. **#4 node error** (`runner.ts:63-73`) — largest capability gap in the engine (heddle cannot
   recover from *any* failure), smallest diff, and it is the cleanest place to prove the middleware
   verdict vocabulary.
2. **#25 plugin context** (`plugin/types.ts:55-64`) — purely additive; every value is already in
   `deps` at `plugin/executor.ts:51-55`. `callModel` alone unlocks LLM-as-judge nodes, semantic
   routers and summarizers without each plugin shipping its own SDK *and its own credential*.
3. **#1+#2 providers** (`llm/provider.ts:141`) — best leverage/cost ratio in the codebase; the
   interface is already one method. Needs #26 first or a provider plugin receives nothing to act on.
4. **#5 tool call** (`agent.ts:190-249`) — this is the mechanism `Agent.humanInTheLoop`
   (`spec/types.ts:46`) promises and nothing implements. Grep confirms the field is read nowhere.
5. **#11 tool registry** (`tool/types.ts:44-47`) — two methods, and the demand is already proven:
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
`ChatChunk`, a `before`/`after` partial is progress on a middleware. Typing the frame against any one
of them would make the others liars. What the frame owes the host is routing, and routing needs only
the `id`.

### 7.2 The widened `PluginMethod` set

This is the cheap axis, and the one that changes what people can build.

```ts
export type PluginMethod =
  | 'runTool'      // exists
  | 'callModel'    // §7.6
  | 'emitEvent'    // progress reporting
  | 'log'          // structured logging that is not "hope stderr is read"
  | 'getState'     // read the run's accumulated State
  | 'getWorkspace' // the sandbox workspace path for this scope
  | 'callPlugin';  // deliberately NOT proposed — see Open questions
```

| Method | Rationale | Serving code |
|---|---|---|
| `callModel` | The single highest-value addition. Without it, an LLM-as-judge node, a semantic router or a summarizer must ship its own SDK *and* obtain its own credential — and a submitted plugin has an empty environment (`PluginHost.resolveCommand`), so it cannot. The engine already holds a `Provider`. | New arm in `PluginHost.serve` (`host.ts:573-620`), backed by a `ModelRunner` installed the way `setToolRunner` is (`host.ts:180`) — but per-node, not first-writer-wins. |
| `emitEvent` | A plugin node is silent between `node_start` and `node_complete` (`runner.ts:47,77`). Requires opening `EventType` (`runner/events.ts:4-13`) to a namespaced `string` plus a `data?: unknown` payload. | `deps.eventHandler` is already in scope at `plugin/executor.ts:51-55`. |
| `log` | `console.log` is silently redirected to stderr (the generated runtime's `console` shim, `plugin/runtime-source.ts`) and stderr is bounded to 4096 bytes and only surfaced on failure (`host.ts:70,369-370,382`). There is no way for a working plugin to say anything. | Same handler as `emitEvent`, `type: 'warning'`-adjacent. |
| `getState` | `execute` receives only the node's resolved input (`plugin/remote.ts:75-79`), which after `resolveInputs` is *usually* the whole state (`runner.ts:112-114`) but is not guaranteed to be. Explicit beats incidental. | Requires the Runner to hand `currentState` to `Dependencies` per node — a real change, and the weakest item on this list. |
| `getWorkspace` | The sandbox workspace exists and is exported to tools as `$HEDDLE_WORKSPACE` but is never surfaced to a plugin (`sandbox/types.ts`). A plugin that runs two tools cannot find the file the first one wrote. | The scope is right there at `plugin/executor.ts:38`. |

Note what is *not* here: no `readFile`, no `fetch`, no `getEnv`. The process boundary denies those,
and re-granting them over RPC would hand back exactly what `plugin/host.ts:10-17` bought.

### 7.3 The capability model — and why it must land first

**Manifest declaration.**

```json
{
  "name": "reviewer",
  "version": "2.1.0",
  "capabilities": ["runTool", "callModel", "emitEvent"],
  "components": [{ "componentType": "LlmJudge", "kind": "node" }]
}
```

Validated in `validateManifest` (`packages/core/src/plugin/manifest.ts:79`) against a closed set,
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
**spends** it, without limit, on a provider built with `defaultKey` at `provider.ts:111`. And unlike
a spec's `llm_config`, the plugin's calls are not visible anywhere in the document the caller
submitted: `execute` is opaque by construction (`plugin/remote.ts:75-79`). That reopens the
operator-credential exposure `applyDefaultCredential` closed, through a door the function cannot
see. The same argument applied to `runTool`, which is why the gate in `serve()` was load-bearing and
had to survive being generalized — it started life as an accidental side effect of only one method
existing, and is now the deliberate two-stage check above.

Server default, given that `--allow-request-code` already refuses `$VAR` dereference for submitted
specs: `callModel` is **denied by default whenever a default credential is configured**, and the
denial message says so, because a caller whose plugin silently ran unauthenticated would have no
idea why — the same reasoning as `provider.ts:88-90`.

**The transform inconsistency was fixed in the same change.** `remoteTransformDef.createTransform`
took one parameter and dropped the `deps` the interface declares (`plugin/types.ts`), so a
transform's `runTool` failed for want of a runner — *unless* the same plugin also provided a node
that had already run, in which case `setToolRunner`'s first-writer-wins had installed one and it
worked. Capability that depends on unrelated graph structure is not a capability model. It now
installs its own runner, covered by "runs a tool on the transform behalf" in
`plugin/__tests__/remote.test.ts`.

### 7.4 The `middleware` kind

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
(`PluginHost.serve`, `plugin/host.ts:573-620`, serves plugin-initiated requests), but it means a run's control flow is
suspended inside another process, and a plugin that returns without calling `next` hangs the run
until the call timeout fires (`host.ts:223-227`). Instead: a `before`/`after` pair that returns a
verdict — the same shape `TransformResult` already has (`plugin/types.ts:97-102`), which is the
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
  stopping at the first rejection (`plugin/transform.ts:154-165`).
- **Which verdicts are neutral.** In `before`, `proceed` is neutral and `modify` continues the chain
  (see the next bullet); `replace` and `reject` short-circuit. In `after`, `pass` is neutral;
  `replace`, `retry` **and** `fail` all short-circuit. Extending the short-circuit to every
  `AfterVerdict` is deliberate: it makes retry-vs-`fail` and retry-vs-retry conflicts unreachable by
  construction, so the design owes no ranking between them. Collect-then-rank would be the
  alternative, and it would need a justification for why `after` ranks while `before` short-circuits.
- **Two middlewares both modifying**: modifications compose. Each sees the previous one's output,
  exactly as `plugin/transform.ts:174` does (`current = result.messages`).
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
  (`plugin/executor.ts:71-81`). A `replace` verdict on `node` supplies a `State`, never a route.

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

```ts
// packages/core/src/plugin/remote-loader.ts — RemotePluginOptions, continued from §7.3
  /**
   * Per-componentType configuration for host-configured components. Validated
   * against that component's manifest `schema` at load time, with the same
   * closed-set, load-time-error treatment `kind` already gets
   * (`plugin/manifest.ts:123-128`) — a middleware whose required fields are
   * missing fails to load, naming the field, rather than reading `undefined` on
   * the first node that errors.
   */
  componentConfig?: Record<string, unknown>;
```

with `--plugin-config <componentType>=<json>` on the CLI and the equivalent key in the server config.
`ctx.component` for a middleware is exactly that validated object, delivered on every call as
`BeforeParams.component` / `AfterParams.component` (§7.1) — the protocol carries no component payload
today, and middleware is what makes it necessary.

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

### 7.6 Provider plugins

```ts
// packages/core/src/plugin/types.ts — proposed
export interface PluginProviderDef extends PluginComponentDef {
  /**
   * Lifetime is per compiled graph, not per execute. AgentExecutor memoizes
   * (node/agent.ts:58-65) but LLMExecutor rebuilds on every execution
   * (node/llm.ts:33-37) — a provider holding a token bucket or a response cache
   * would be silently defeated by the second. Fixing llm.ts is a precondition,
   * not a follow-up.
   */
  createProvider(config: PluginComponent, deps: Dependencies): Provider;
}
```

Three prerequisites. The first two are cheap; all three are mandatory:

1. **`Dependencies` gains a factory.** `createProvider` must stop being a directly-imported free
   function (`node/agent.ts:17`, `node/llm.ts:5`) and become reachable through `Dependencies`
   (`node/types.ts:12-49`). Without this, nothing — not a plugin, not an embedder — can substitute it.
2. **`ChatRequest` must carry something worth acting on.** It is `{ model, messages, tools? }`
   (`llm/types.ts:30-34`) and the OpenAI adapter passes exactly those three. `defaultGenerationParameters`
   is declared on `LLMConfig` (`spec/types.ts:24`) and — grep-confirmed — read nowhere. **No spec can
   set temperature or request JSON mode today.** A provider plugin would receive nothing to differ on.
3. **`Provider` already carries its streaming form** — settled in Phase 2, not here (§7.5).
   `chatCompletionStream?(signal, req): AsyncIterable<ChatChunk>` is on the interface, optional, with
   `llm/openai.ts` its only implementation so far. A provider contract published without it would have
   been a contract that breaks later.

   **What this phase still owes is the bridge between two shapes of stream, and it is not free.** A
   `Provider` streams by *pull*: an `AsyncIterable` the consumer drives, which ends by returning and
   fails by throwing, so back-pressure and mid-stream failure both have somewhere to live. A plugin
   streams by *push*: `{ id, partial }` frames the host receives whenever they arrive, delivered to
   an `onPartial` callback (`PluginHost.call`) that has no way to say "slower", no end marker, and no
   failure channel except the call's own response. A `chat` verb has to present the second as the
   first. Three rules make that work, and all three have to be stated before the first provider
   plugin exists rather than discovered by it: each partial's payload is one `ChatChunk`; the call's
   response is the end of the stream, so a stream that ends without one is a failed call and not an
   empty answer; and a plugin that streams for longer than the per-call timeout stays alive only
   because each partial resets it (§7.1), which means a provider plugin that buffers internally and
   emits nothing is killed exactly like one that hung.

**The placeholder-`LLMConfig` problem — and why it is now a scheduling question, not a design one.**
Everything below describes the cost of making a provider *spec-named* (a flow writing
`component_type: AnthropicConfig`) **under the placeholder mechanism**. Since `vendor/agentspec` is
ours to patch (§8), that cost is avoidable: extend `LlmConfigUnion` in the SDK and there is no
placeholder to pay for. The analysis is kept because it is the sharpest illustration of why the
placeholder approach does not scale, and because it prices the fallback if the SDK work slips.

Under placeholders, this is the most expensive stand-in yet:

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

That fork was genuinely balanced only while the placeholder was the sole route. It is not:
**extend `LlmConfigUnion` in the vendored SDK and spec-named providers cost nothing extra**, so the
spec keeps the ability to name its own provider and heddle keeps one mechanism instead of two. The
host-configured form survives as the interim answer if provider plugins are wanted before the SDK
work lands — but it is a stopgap with a migration, not a co-equal design.

### 7.7 Registry / tool-source plugins

`Registry` is two methods (`packages/core/src/tool/types.ts:44-47`) — the cheapest component kind on
the list, and demand is proven: the server had to write registry composition *outside* core
(`packages/server/src/tools.ts:15-29`) because none existed inside.

The one real constraint: **`lookup` must stay synchronous.** It is called inside execution at
`node/agent.ts:267` and `plugin/remote.ts:234`, and at request-validation time by
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
`--plugin-config RetryPolicy='{"maxAttempts":3}'`, validated against the manifest `schema` above at
load time (§7.4), and the host's own ceiling still applies underneath it.

**(b) An LLM-judge node, using `callModel`.**

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
declared set (`plugin/executor.ts:71-81`) rather than letting it surface as a confusing
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
(`PluginHost.resolveCommand`, `plugin/host.ts:473-500`). That is a policy question the capability list does not currently
model, and it is one of the open questions below.

### 7.9 The `encoder` kind

Every kind so far answers "what runs inside a flow". This one answers "what the run looks like on
the wire", and it falls outside the taxonomy in §5 — it is neither a spec-named slot nor an
interception around an engine step. It is a **sink on the event stream**.

Today that layer is a free function with exactly one rendering:

```ts
// packages/server/src/sse.ts:19-34
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
  is `{ signal, phase, component }` (`plugin/types.ts:104-108`) — there is no path from it to the
  client at all. It is a message filter; AG-UI is a wire format.
- A **node** returns `{ output, branch }` once, at the end (`plugin/types.ts:47-52`). A terminal node
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

The one genuine cost is that opening this layer makes the `Event` shape a **public contract**. Today
`Event` (`runner/events.ts:16-49`) is an internal struct that `serializeEvent` happens to mirror;
`packages/server/src/sse.ts:4-18` is explicit that the wire form is the engine's own model. Once
third-party encoders consume it, adding a field is fine and changing one is a break. That argues for
versioning `Event` at the same time, and for the namespaced `EventType` widening in Phase 3 landing
first so encoders see the final shape rather than the current closed enum.

### 7.10 Open questions

1. **~~Spec-named or host-configured providers?~~ Resolved by §8.** This was balanced only while the
   placeholder was the only route to a custom `LlmConfig`. Extending `LlmConfigUnion` in the vendored
   SDK costs nothing per-provider, so spec-named wins and host-configured survives only as an interim
   answer if provider plugins are wanted before the SDK work lands. Kept here rather than deleted
   because the reasoning inverts again if the SDK work is abandoned.
2. **Does `retry` belong on `nodeError` only, or on every seam?** Universal retry is a much larger
   contract: the host must be able to re-invoke the underlying call idempotently, which is true at
   `runner.ts:61` and emphatically not true partway through the tool loop at `agent.ts:190-249`,
   where earlier tool messages are already in `messages`.
3. **Is a middleware failure fatal or skipped?** A middleware that throws at `runner.ts:61` fails
   runs it has nothing to do with (§10). Fatal is honest; skipped is survivable. The tempting split —
   fatal for seams with `reject` power, skipped for observe-only — is undermined by the fact that a
   `reject`-capable middleware failing open is a *security* failure for a guardrail and a
   *reliability* failure for everything else. Unresolved.
4. **Network policy for plugins.** The current model denies the environment and (optionally) the
   filesystem; it says nothing about the network. Example (c) needs it, guardrails plugins must not
   have it. Neither `SandboxPolicy` nor the proposed capability list expresses it today.
5. **Should `getState` exist at all?** It requires threading `currentState` through `Dependencies`,
   and the value it adds over the node's resolved input is small in practice, since `resolveInputs`
   returns the whole accumulated state whenever a node has no mappings (`runner.ts:112-114`). Weakest
   item in §7.2.
6. **Does `listTools` justify starting a process during load?** It breaks the one property that makes
   `/v1/validate` cheap (`remote-loader.ts:109-111`). Manifest-declared tools cover most real cases;
   MCP discovery is the case that does not, and it is the case people will ask for.
7. **Should a plugin ever be allowed to claim a builtin type?** `plugin/registry.ts:77-83` forbids it,
   which means the two transforms heddle skips (`plugin/transform.ts:19-22`) can never be supplied by
   a plugin — the feature is impossible in both directions at once. Allowing it needs a precedence
   rule and an explicit `implements: "builtin"` opt-in so shadowing is visible, and the compiler's
   plugin-first lookup (`graph/compile.ts:74-80`) would need its comment corrected.

---

## 8. The agentspec placeholder tax — and how to stop paying it

Every new **component** kind — as opposed to a middleware or a `PluginMethod` — needs a hand-picked
placeholder, because the SDK's unions are closed (§2.4) and heddle's only tool is substitution
(`plugin/flow-preprocess.ts:1-21`).

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
| 3 `PluginContext` | 1, 2 | |
| 4 `callModel` | 1, 3 | |
| 5 Provider kind | 2, 4 | *strongly prefers* V |
| 6 Middleware kind | 1, 2, 3 | |
| 7 Registry | 1 | off the main line |
| 9 Encoder | 2, 3 | off the main line |
| **V** SDK extension | — | independent; land before 5 |

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
- **The CLI and the playground do not render `token_delta`.** Both ignore unknown event types, so
  neither broke, and neither shows a token. `packages/cli/src/cli/run.ts` has no arm for it;
  `website/lib/playground.ts`'s `RunEvent` has no `delta` field and `RunLog.tsx` has no label, so the
  playground currently renders one unlabelled row per token. Streaming is a contract, not a feature,
  until a consumer draws it.

**Depended on:** Phase 1 (`init` carries the granted capability set).
**Unblocks:** Phase 5 inherits a settled `Provider`; Phase 9 gets something worth encoding;
cooperative cancellation; every future frame without a compatibility break.

### Phase 3 — `PluginContext` widening

`emitEvent`, `log`, `getWorkspace`. In-process first — every value is already in `deps` at the
construction site (`plugin/executor.ts:51-55`) — then the RPC forms. Requires opening `EventType`
(`runner/events.ts:4-13`) to a namespaced string plus a `data?: unknown` payload.

**Depends on:** Phases 1, 2.
**Unblocks:** any plugin that wants to report progress. Also fixes the observability gap where a
plugin node is silent between `node_start` and `node_complete`.
Cost: low.

### Phase 4 — `callModel`

**Depends on:** Phase 1 (mandatory — §7.3), Phase 3 (the serving path), and the `ChatRequest`
widening from §7.6 item 2.
**Unblocks:** LLM-as-judge, semantic routers, summarizers, self-critique — the largest single class
of plugin people ask for.
Cost: medium. Most of it is `ChatRequest`/`Message` widening, which touches `buildMessages` and
`buildTools` (`llm/openai.ts:176-230`).

### Phase 5 — Provider kind

**Depends on:** Phase 2 (the settled `Provider` shape, including streaming); Phase 4's `ChatRequest`
work; `createProvider` becoming injectable through `Dependencies`; and the `node/llm.ts:33`
per-execute construction being fixed — a provider holding a token bucket or a response cache is
silently defeated otherwise.

**Strongly prefers Phase V.** With `LlmConfigUnion` extended, spec-named providers cost nothing extra
and §7.10 Q1 resolves itself. Without it, this phase either pays the most expensive placeholder in
the codebase or ships the host-configured stopgap and carries a migration later.

**Unblocks:** Anthropic/Bedrock, record-replay CI, retry and caching wrappers (seam #2).
Cost: medium after Phase V; high before it.

### Phase 6 — Middleware kind

Start with **`nodeError` only** — one seam, the largest gap, the smallest diff, and the cheapest
place to discover that the verdict vocabulary is wrong. Then `toolCall` (which is what
`humanInTheLoop` at `spec/types.ts:46` has been promising), then `node`, then the rest.

**Depends on:** Phases 1, 2, 3.
**Unblocks:** retry, approval gates, caching, dry-run, result truncation, policy enforcement.
Cost: **high, and higher than it looks.** Restructuring `runner.ts:61-73` is easy. Deciding whether a
middleware failure is fatal (§7.10 Q3), keeping ordering comprehensible when three plugins register
on one seam, and paying an IPC round trip per node per middleware (§10) are all real. Budget for the
policy, not the plumbing.

### Phase 7 — Registry / tool-source

Independent of 4–6, needs only Phase 1. Manifest-declared tools first; `listTools` only if §7.10 Q6
resolves in its favour.

**Unblocks:** MCP tool discovery, HTTP tool catalogues, single-source-of-truth tool descriptions.
Cost: low.

### Phase V — Vendored SDK extension (formerly Phase 8) — **tier 1 landed, tier 2 open**

Blocked by nothing; run it alongside Phases 0–3.

**Tier 1 — done.** `vendor/agentspec/src/index.ts` re-exports `registerNodeUnionSchema` and
`registerFlowSchema` from `src/flows/lazy-schemas.js` (§8.1), and the `VENDOR.md` bookkeeping landed
with it — *Local modifications* is now a numbered patch series, without which the next vendor
refresh reverts the export silently. A regression test pins the export:
`packages/core/src/plugin/__tests__/vendor-schema-registration.test.ts`.

**What tier 1 does not yet buy.** The seam is exported and nothing calls it. `NodeUnion` is still
closed in practice, so `plugin/flow-preprocess.ts` and its restore path in `spec/adapter.ts` remain
load-bearing for **every** plugin node: a flow carrying one is still handed to the SDK as an
`InputMessageNode` stand-in and swapped back by id. Read §8.1's Tier 1 "Buys" column as what becomes
possible, not as work already delivered — the placeholder machinery goes away when a caller
registers a widened `NodeUnion`, which is a separate change.

**Tier 2 — open.** Lazy indirection and registration for `MessageTransformUnion`, `LlmConfigUnion`
and `ToolUnion`; `src/flows/lazy-schemas.ts` still exports only the two node/flow functions.

**Unblocks:** deleting `plugin/flow-preprocess.ts` entirely; every future component kind's placeholder
cost; and the cost model of Phase 5.
Cost: medium for tier 2. This was scheduled last on the assumption that it required upstream
cooperation — it does not.

### Phase 9 — Encoder kind

`kind: 'encoder'` (§7.9), selected per request rather than named in a spec, with AG-UI as the first
implementation and heddle's current frames re-expressed as the builtin one.

**Depends on:** ~~Phase 2 (token streaming)~~ — satisfied: `token_delta` exists, so AG-UI no longer
degrades to a single `TextMessageChunk` carrying the whole answer. Still needs Phase 3 (a namespaced
`EventType`, so encoders see the final `Event` shape rather than today's closed enum), and still owes
the message-boundary decision in §7.9. Independent of 4–7.

**Unblocks:** CopilotKit and any AG-UI client against a heddle flow with no adapter in between;
OpenAI-compatible chunk output; OTLP span export from the same event stream.
Cost: low — but it promotes `Event` (`runner/events.ts:16-49`) from an internal struct to a public
contract, so version it in the same change.

---

## 10. Risks and non-goals

### Compatibility surface

`HeddlePlugin` and friends are exported from `packages/core/src/index.ts:76-136`, so they are public
API. Adding optional fields (`capabilities`, `seams`, `providers`) is safe. Changing
`PluginNodeDef.createExecutor`'s signature (`plugin/types.ts:142`) is not, and the shipped
`examples/guardrails/plugin.js` is a live consumer of the in-process shape — the examples test loads
it for every example that ships one.

Separately: the two authoring APIs are already not feature-equivalent (§3.3), and every phase widens
the gap. Either the in-process API gets the same additions, or its narrower scope becomes explicit
documentation rather than an accident.

Two new contracts appear in this revision and both are easy to create by accident:

- **`Event` becomes public the moment encoders exist** (§7.9). Today it is an internal struct
  (`runner/events.ts`) that `packages/server/src/sse.ts` explicitly describes as "the same
  event model the engine already emits". Once third-party code renders it, adding a field is safe and
  changing one is a break. Version it in Phase 9, not after the first encoder ships.

  Phase 2 found the sharp edge on the way there, and it is worth naming because every phase that adds
  an event will meet it. `serializeEvent` copies a **fixed list of fields**, so a field added to
  `Event` and not added there is dropped with no type error and no warning: the engine emits it, the
  browser never sees it, and nothing anywhere says so. `message` had been in exactly that state since
  the function was written, which meant every `warning` frame reached clients empty. It is now
  covered by a test that walks a fully-populated `Event` and asserts nothing is missing
  (`packages/server/src/__tests__/sse.test.ts`), which is the only form of this that survives someone
  adding a field in a hurry.
- **A patched `vendor/agentspec` is a fork** (§8.1). It is a cheap one — the package is unpublished
  and bundled via `noExternal`, so there is no downstream consumer — but the refresh workflow in
  `VENDOR.md` assumes a verbatim copy and will silently revert the patches if it is followed as
  written. The bookkeeping change is part of the work, not a follow-up.

### A hook that runs on every node can break every flow

This is the sharpest new risk and it has no precedent in the current design. A `transform` only
affects agents that declare it (`plugin/transform.ts:74`). A middleware on `node` affects
**everything**, including flows written before the middleware existed and by people who have never
heard of it. A middleware that throws at `runner.ts:61` fails runs it has nothing to do with.

Mitigations, all of which should ship *with* Phase 6 and not after:

- Seams are declared per component in the manifest, so the blast radius is inspectable as data
  before anything runs — the same property `manifest.ts:1-19` already buys.
- An error policy, decided rather than defaulted (§7.10 Q3).
- A middleware may not introduce a branch: `graph/validate.ts:26-51` checks reachability before
  execution, and `plugin/executor.ts:71-81` already enforces the analogous rule for nodes.
- A `replace` verdict is reported as a `warning` event, so "the flow returned something odd" is
  traceable to the middleware that did it.

### Performance of per-call IPC

`runner.ts:61-62` costs one `await` today. With two middlewares on the `node` seam it costs four JSON
Lines round trips through a pipe, plus four full serializations of the node's `State` — and
`plugin/remote.ts:43-51` already does a complete `JSON.parse(JSON.stringify(...))` round trip of the
component's spec fields once per compiled node (`remote.ts:68`), on top of the per-call framing in
`encode` (`protocol.ts:297-302`). A 20-node flow with two middlewares is 80 round trips carrying the accumulated
state each time, and `State.merge` is a shallow spread that only grows (`state/state.ts:36-38`).

`modelCall` and `toolCall` middleware are less alarming because the underlying operation is already
network- or process-bound. `node` middleware on a fast graph is the case that will hurt. Two
defences worth designing in from the start: per-seam registration so a plugin is only asked about
seams it declared, and a `subject` payload that carries references rather than the whole state where
the seam permits it.

### What stays closed, and why

| Closed | Where | Why |
|---|---|---|
| `State` as a replaceable type | `state/state.ts`; `NodeExecutor` is typed against the concrete class (`node/types.ts:7`) | A merge-*policy* slot (seam #17) gets the value at one call site (`runner.ts:89`). Replacing `State` wholesale touches every executor for no proportionate gain. |
| Sandbox confinement moving out of the executor | `sandbox/types.ts:1-8` | The design's whole point is that nothing in the graph, node or spec layers knows a sandbox exists. Per-tool *policy* (seam #29) is reachable without breaking that. |
| Prototype-pollution key filtering | `plugin/deserializer.ts:50,124-126` | Applied both before and after camelCasing, on a path that parses caller-supplied JSON. Not negotiable. |
| Builtin type shadowing | `plugin/registry.ts:77-83` | Only with an explicit `implements: "builtin"` opt-in and a stated precedence rule (§7.10 Q7). The default stays: a plugin cannot silently become `AgentNode`. |
| `$VAR` dereference for submitted specs | `llm/provider.ts:32-53` | The reference is not restricted to model credentials, and the "is not set" error is an enumeration oracle. |
| Plugins in the server's process | `packages/server/src/plugins.ts:9-18` | Everything above is designed *around* this constraint. If a proposal is easier in-process, that is a reason to reject the proposal. |
| Environment inheritance | `PluginHost.resolveCommand` (`plugin/host.ts:473-500`), `packages/server/src/plugins.ts:40` | Named capabilities grant heddle-mediated *operations*, never raw process access. There is no `getEnv`, and there should not be one. |
| An encoder that can alter the run | §7.9 | `Event → WireFrame[]` is one-directional on purpose. An encoder renders what happened; giving it a return path would make it middleware with none of §7.4's ordering rules, and a rendering layer that can change the thing it renders is not a rendering layer. |
| Divergence from the Agent Spec *format* | §8.1 | Extending the SDK's unions is in scope; inventing fields or semantics that make a heddle spec unreadable to another Agent Spec implementation is not. Every patch should be one upstream would plausibly accept. |
