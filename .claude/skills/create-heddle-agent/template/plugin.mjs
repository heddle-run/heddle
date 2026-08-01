/**
 * A heddle plugin: one custom component type, `SecretScrub`.
 *
 * It is a *transform*, so it hangs off `Agent.transforms` and runs around the
 * model call — `pre` on the way out, `post` on the way back. The other kinds a
 * plugin can contribute are `nodes` (placed in the graph), `providers` (a model
 * endpoint), `encoders` (a wire format) and `middleware` (installed by the
 * operator, never named by a document).
 *
 *   heddle run spec.yaml --tools-dir tools --plugin ./plugin.mjs
 *
 * A plugin is only ever loaded from the command line, never from the spec, so
 * sharing a spec cannot cause code to run.
 */

const PHASES = new Set(['pre', 'post', 'both']);

/** The message a transform is about: the newest one. */
function subject(messages) {
  return messages.at(-1);
}

function replaceLast(messages, content) {
  return [...messages.slice(0, -1), { ...subject(messages), content }];
}

/**
 * What the agent was handed, as an object.
 *
 * heddle sends the node's input state as the user message, JSON-encoded, so this
 * is how a transform reads the flow's data rather than only its prose.
 */
function inputState(messages) {
  const user = messages.find((message) => message.role === 'user');
  try {
    const parsed = JSON.parse(user?.content ?? '');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function scrub(text, patterns, replacement) {
  let out = String(text ?? '');
  for (const pattern of patterns) {
    out = out.replace(new RegExp(pattern, 'g'), replacement);
  }
  return out;
}

export default {
  name: 'heddle-plugin-secret-scrub',
  version: '1.0.0',

  transforms: [
    {
      componentType: 'SecretScrub',

      /**
       * Called once per component at load time, before anything runs.
       *
       * Throwing here is how a plugin refuses a spec — `heddle validate` reports
       * it, so a misconfigured component never reaches a run.
       */
      validate(component) {
        const phase = component.phase ?? 'pre';
        if (!PHASES.has(phase)) {
          throw new Error(
            `SecretScrub "${component.name}": phase must be one of ${[...PHASES].join(', ')}, ` +
              `got "${phase}"`,
          );
        }
        if (component.patterns !== undefined && !Array.isArray(component.patterns)) {
          throw new Error(`SecretScrub "${component.name}": patterns must be an array`);
        }
        for (const pattern of component.patterns ?? []) {
          try {
            new RegExp(pattern);
          } catch (err) {
            throw new Error(
              `SecretScrub "${component.name}": /${pattern}/ is not a valid regex — ${err.message}`,
            );
          }
        }
      },

      phase: (component) => component.phase ?? 'pre',

      createTransform(component) {
        const patterns = component.patterns ?? [];
        const replacement = component.replacement ?? '[REDACTED]';
        const required = component.require ?? [];

        return {
          apply(messages, ctx) {
            // A `pre` rejection skips the model call entirely, so a refused
            // request costs nothing. The agent then writes
            // transform_status: "rejected", which a BranchingNode can route on.
            if (ctx.phase === 'pre') {
              const state = inputState(messages);
              const missing = required.filter((key) => !String(state[key] ?? '').trim());
              if (missing.length > 0) {
                ctx.log('warn', `no ${missing.join(', ')} in the payload; handing off`);
                return {
                  action: 'reject',
                  reason: `the payload names no ${missing.join(', ')}`,
                  messages: replaceLast(
                    messages,
                    `Cannot triage without ${missing.join(', ')}. Handing off to a human.`,
                  ),
                };
              }
            }

            const before = subject(messages)?.content ?? '';
            const after = scrub(before, patterns, replacement);
            if (after === before) return { action: 'pass' };

            // An event a plugin emits reaches the CLI's progress output and the
            // server's event stream, named `plugin:SecretScrub:redacted`.
            ctx.emitEvent('redacted', { phase: ctx.phase });
            return { action: 'modify', messages: replaceLast(messages, after) };
          },
        };
      },
    },
  ],
};
