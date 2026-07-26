/**
 * heddle plugin: Processor
 *
 * Adds one custom Agent Spec component type:
 *
 *   Processor  a MessageTransform that runs before or after an agent's model call
 *
 * It attaches to `Agent.transforms`, the slot Agent Spec already defines for
 * components that process an agent's messages. That means a Processor travels
 * with the agent rather than with a flow's graph, so it applies in chat mode and
 * to a standalone agent too — not only inside a flow.
 *
 * A Processor is just a function:
 *
 *   (messages, ctx) => { action: 'pass' }
 *                    | { action: 'modify', messages: newMessages }
 *                    | { action: 'reject', reason, messages? }
 *
 * `reject` is what makes this a guardrail. In the `pre` phase heddle skips the
 * model call entirely, so a blocked prompt costs nothing; the agent returns
 * `transform_status: "rejected"`, which a downstream BranchingNode can route on.
 *
 * Plain ESM with no imports, so it loads under both the built CLI and
 * `npm run dev`. TypeScript authors can import `definePlugin` from heddle for
 * type checking.
 */

/** The message a guardrail cares about: the last one in the list. */
function subject(messages) {
  return messages.at(-1);
}

/** Returns `messages` with the last one's content replaced. */
function replaceLast(messages, content) {
  return [...messages.slice(0, -1), { ...subject(messages), content }];
}

/**
 * Built-in processor implementations, keyed by the `handler` named in the spec.
 * Add a function here — or push onto this object from your own module — and it
 * becomes available to any agent that loads this plugin.
 */
export const handlers = {
  /** Reject when the message matches any pattern. */
  blocklist(messages, { config }) {
    const content = subject(messages)?.content ?? '';
    for (const pattern of config.patterns ?? []) {
      if (new RegExp(pattern, 'i').test(content)) {
        return {
          action: 'reject',
          reason: config.reason ?? `matched blocked pattern /${pattern}/`,
          messages: config.refusal
            ? replaceLast(messages, config.refusal)
            : undefined,
        };
      }
    }
    return { action: 'pass' };
  },

  /** Rewrite matches out of the message — PII on the way in, secrets on the way out. */
  redact(messages, { config }) {
    const content = subject(messages)?.content ?? '';
    const replacement = config.replacement ?? '[REDACTED]';
    let out = content;
    for (const pattern of config.patterns ?? []) {
      out = out.replace(new RegExp(pattern, 'gi'), replacement);
    }
    return out === content
      ? { action: 'pass' }
      : { action: 'modify', messages: replaceLast(messages, out) };
  },

  /** Cap the length, either by truncating or by refusing outright. */
  max_length(messages, { config }) {
    const content = subject(messages)?.content ?? '';
    const limit = config.limit ?? 2000;
    if (content.length <= limit) return { action: 'pass' };
    if (config.mode === 'reject') {
      return {
        action: 'reject',
        reason: `message is ${content.length} characters, limit is ${limit}`,
      };
    }
    return {
      action: 'modify',
      messages: replaceLast(messages, content.slice(0, limit)),
    };
  },

  /**
   * A guardrail specific to this example, to show that a Processor is only ever
   * an ordinary function: refuse answers that hedge without saying anything.
   */
  require_substance(messages, { config }) {
    const content = subject(messages)?.content ?? '';
    const minWords = config.min_words ?? 3;
    if (content.trim().split(/\s+/).filter(Boolean).length >= minWords) {
      return { action: 'pass' };
    }
    return { action: 'reject', reason: 'response was too short to be useful' };
  },
};

const PHASES = new Set(['pre', 'post', 'both']);

export default {
  name: 'heddle-plugin-guardrails',
  version: '1.0.0',

  transforms: [
    {
      componentType: 'Processor',

      validate(processor) {
        if (typeof processor.handler !== 'string') {
          throw new Error(
            `Processor "${processor.name}": "handler" is required`,
          );
        }
        if (!(processor.handler in handlers)) {
          throw new Error(
            `Processor "${processor.name}": unknown handler "${processor.handler}". ` +
              `Available: ${Object.keys(handlers).join(', ')}`,
          );
        }
        const phase = processor.phase ?? 'pre';
        if (!PHASES.has(phase)) {
          throw new Error(
            `Processor "${processor.name}": "phase" must be one of ` +
              `${[...PHASES].join(', ')}, got "${phase}"`,
          );
        }
      },

      phase: (processor) => processor.phase ?? 'pre',

      createTransform(processor) {
        const handler = handlers[processor.handler];
        const config = processor.config ?? {};

        return {
          apply: (messages, ctx) => handler(messages, { config, ...ctx }),
        };
      },
    },
  ],
};
