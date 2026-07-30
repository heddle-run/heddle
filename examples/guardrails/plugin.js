function subject(messages) {
  return messages.at(-1);
}

function replaceLast(messages, content) {
  return [...messages.slice(0, -1), { ...subject(messages), content }];
}

export const handlers = {
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
