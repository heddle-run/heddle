/**
 * What a plugin may ask heddle to do, built from the compiled graph's
 * dependencies.
 *
 * One module for both halves of that, because both are answered the same way
 * and both used to be answered twice. `runTool` had two implementations — one
 * in `executor.ts` bound to a node's tool scope, one in `remote.ts` bound to
 * nothing — and a transform reached the second only by accident of load order.
 * `callModel` arrives with the same shape of temptation: a node has an obvious
 * place to build a provider and a transform does not, and left to itself that
 * becomes two rules about which components may call a model.
 *
 * The rule this module exists to keep is one sentence: **what a component may
 * do follows from the component, never from where in the spec it was written.**
 */
import { createProvider, generationParams } from '../llm/provider.js';
import type { ChatResponse, ModelRequest, Provider } from '../llm/types.js';
import type { LLMConfig } from '../spec/types.js';
import type { Dependencies } from '../node/types.js';
import { PluginError, RunError, ToolError } from '../errors.js';
import type { PluginComponent } from './types.js';

/** Runs one of the flow's tools by name. */
export type ToolRunner = (
  name: string,
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** Asks the model one question and waits for the whole answer. */
export type ModelCaller = (request: ModelRequest) => Promise<ChatResponse>;

/**
 * The `runTool` a component gets when it has no tool scope of its own.
 *
 * Scopeless, and that is what makes it a fallback rather than the path. The
 * caller's confinement still applies to each tool, but a tool started here gets
 * a throwaway sandbox session, so it shares a workspace with nothing —
 * including the component that asked for it. A node's own `runTool` therefore
 * comes from `PluginNodeAdapter`, which opened a scope for the execution; this
 * serves the cases that have no scope to offer, which is every transform and
 * every plugin that hand-rolls the protocol without naming its call.
 *
 * `where` names the component in the error, and is the only thing that differs
 * between two of these.
 */
export function toolRunner(where: string, deps: Dependencies): ToolRunner {
  return async (name, input) => {
    const { toolRegistry, toolExecutor } = deps;

    if (!toolRegistry || !toolExecutor) {
      throw new RunError(`${where}: no tool registry configured`);
    }
    const tool = toolRegistry.lookup(name);
    if (!tool) {
      throw new ToolError(`${where}: tool "${name}" not found`);
    }
    const result = await toolExecutor.execute(undefined, tool.path, input);
    return result.output;
  };
}

/**
 * The model one plugin component may call, and the provider behind it.
 *
 * **Which model is the spec's decision, not the plugin's.** The config comes
 * from the component's own `llm_config` — the same field an `LlmNode` and an
 * `Agent` carry, deserialized the same way — so a flow's author can read the
 * document they submitted and see every endpoint their run will reach. A plugin
 * that named its own would make that unknowable, and a plugin *given* the run's
 * provider would make it depend on which other node happened to compile first,
 * which is the failure `setToolRunner` already had once.
 *
 * There is deliberately no fallback. A component with no `llm_config` fails at
 * the call, naming the field, rather than quietly borrowing the operator's
 * default endpoint: what a plugin spends has to be visible in the document that
 * asked for it.
 *
 * Held per compiled component rather than per execution, so a provider that
 * carries a connection pool or a token bucket survives a node the flow visits
 * twice. That is the same reason `AgentExecutor` memoizes its own and the
 * reason it matters that `LLMExecutor` does not.
 */
export class PluginModel {
  private provider?: Provider;
  private config?: LLMConfig;

  constructor(
    private readonly where: string,
    private readonly component: PluginComponent,
    private readonly deps: Dependencies,
  ) {}

  /**
   * The caller handed to one execution, carrying that execution's signal.
   *
   * The signal is bound here rather than passed per call because the plugin
   * does not have one to pass: out of process it is a different program, and
   * `ctx.signal` there is its own `AbortController`, not the run's. Binding it
   * on this side is what makes an aborted run cancel a model call a plugin
   * started — without it the run's slot is held until the provider's own
   * timeout, whatever the runner decided.
   */
  bind(signal: AbortSignal | undefined): ModelCaller {
    return (request) => this.call(request, signal);
  }

  /**
   * Buffered, never streamed, and that is a decision rather than an omission.
   *
   * `Provider.chatCompletionStream` exists and `completeChat` would use it. The
   * reason not to is that heddle cannot tell what a plugin's model call *is*.
   * An `AgentNode`'s answer is the node's output, so a `token_delta` carrying
   * it is the run's answer arriving early. A plugin's is as likely to be
   * scratch: the judge in the worked example asks for `{"score":…}`, parses it,
   * and returns a number — streaming that would publish the judge's private
   * reasoning as the run's answer, into the same `token_delta` a client is
   * already rendering as one.
   *
   * A plugin that wants to be watched has `emitEvent` and `log`, which are
   * namespaced and cannot be mistaken for the run's own output. That is the
   * whole of what Phase 3 bought, and it is the right channel for this.
   */
  private async call(
    request: ModelRequest,
    signal: AbortSignal | undefined,
  ): Promise<ChatResponse> {
    const config = (this.config ??= this.readConfig());
    // Lazily, for the reason `AgentExecutor.getProvider` is lazy: building one
    // throws when no credential is configured, and components are constructed
    // by `compile()` — so an eager provider would make validating any flow
    // containing a plugin that *might* call a model impossible without a key.
    this.provider ??= createProvider(config, {
      allowEnvRefs: this.deps.allowEnvRefs,
      defaultKey: this.deps.defaultLlmKey,
      defaultUrl: this.deps.defaultLlmUrl,
    });

    return this.provider.chatCompletion(signal, {
      // The spec's settings first, the plugin's over them. "Default" is the
      // operative word in `default_generation_parameters`: a config says how
      // this model is called in general, and a plugin with a reason to differ
      // on one call — a classification that has to be deterministic — says so
      // per call. `readModelRequest` leaves an unmentioned field absent rather
      // than `undefined`, which is what keeps this a merge and not a reset.
      ...generationParams(config),
      ...request,
      // Last, so no spread can reach it. `ModelRequest` omits `model` and
      // `readModelRequest` never copies one off the wire, but an in-process
      // plugin is plain JavaScript and its object is whatever it built — and
      // "which model answers" is the one field this whole design exists to
      // keep out of a plugin's hands.
      model: config.modelId,
    });
  }

  /**
   * The component's `llm_config`, checked the once.
   *
   * A plugin component's fields are whatever the spec wrote — the manifest's
   * schema may check them and is not obliged to — so this arrives as unknown
   * data even in process. The message is the one a plugin author is most likely
   * to meet, so it says what to add rather than what was missing.
   */
  private readConfig(): LLMConfig {
    const raw = this.component.llmConfig;
    if (raw === undefined) {
      throw new PluginError(
        `${this.where}: callModel needs an "llm_config" on this component, and it ` +
          `has none. A plugin composes the request; the spec chooses the model, so ` +
          `add the same llm_config an agent would carry:\n` +
          `  llm_config:\n` +
          `    component_type: OpenAiConfig\n` +
          `    model_id: gpt-4o-mini`,
      );
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new PluginError(
        `${this.where}: "llm_config" is ${
          raw === null ? 'null' : Array.isArray(raw) ? 'an array' : `a ${typeof raw}`
        }, not a config object.`,
      );
    }
    const config = raw as Partial<LLMConfig>;
    if (typeof config.modelId !== 'string' || config.modelId.length === 0) {
      throw new PluginError(
        `${this.where}: "llm_config" has no "model_id". Every config names the ` +
          `model it reaches, and heddle sends it verbatim.`,
      );
    }
    return config as LLMConfig;
  }
}
