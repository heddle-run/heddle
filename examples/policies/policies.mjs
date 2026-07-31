/**
 * Three policies, one per built seam.
 *
 * Nothing in a flow names any of them. They are installed by whoever runs
 * heddle, they run on every node of every flow that host serves, and their
 * settings arrive on the command line — which is the whole reason a middleware
 * is a different kind of component from a node.
 */

/**
 * A rolling window of model calls, shared by every run this process serves.
 *
 * The one kind of state an installed plugin may keep. A `Map` keyed by run
 * would be the obvious way to write a budget and would be wrong here: one
 * process serves every request on the server, there is no run id in a
 * middleware's context, and a counter that outlives a run is a counter that
 * silently belongs to somebody else. A *process-wide* rate is different — it is
 * a fact about this process, which is exactly what is being limited.
 */
const recentCalls = [];

const ONE_MINUTE = 60_000;

serve({
  /**
   * Retry a node that failed for a reason worth retrying.
   *
   * `nodeError` is consulted only on a failure — there is no `before` half,
   * because nothing precedes an error. The ceiling is heddle's
   * (`--max-node-attempts`, default 3): `ctx.attempt` and `ctx.maxAttempts` say
   * where this attempt sits, and asking to retry past the end is refused with a
   * warning rather than honoured.
   */
  RetryPolicy: {
    nodeError: {
      after: ({ subject, outcome }, ctx) => {
        const { retryOn = ['timed out', '429', 'ECONNRESET'], backoffMs = 500 } =
          ctx.component;

        const transient = retryOn.some((mark) =>
          outcome.error.message.includes(mark),
        );

        if (transient && ctx.attempt < ctx.maxAttempts) {
          ctx.log(
            'warn',
            `"${subject.nodeName}" failed transiently (attempt ${ctx.attempt} of ` +
              `${ctx.maxAttempts}): ${outcome.error.message}`,
          );
          return { action: 'retry', delayMs: backoffMs * ctx.attempt };
        }

        // Out of attempts, or an error no retry would help. `substitute` lets
        // the run continue with a stated value; without one the error stands and
        // the next middleware in the chain gets its say.
        if (ctx.component.substitute) {
          ctx.emitEvent('substituted', {
            node: subject.nodeName,
            cause: outcome.error.message,
          });
          return { action: 'replace', value: ctx.component.substitute };
        }

        return { action: 'pass' };
      },
    },
  },

  /**
   * Refuse a tool call the operator does not want made, and trim one whose
   * answer is too big to be worth what the model pays to read it.
   *
   * `before` is the half that decides; `after` is the half that reacts. A
   * middleware subscribes to each separately, and this one wants both.
   */
  ApprovalGate: {
    toolCall: {
      before: ({ subject, input }, ctx) => {
        const patterns = (ctx.component.guard ?? {})[subject.toolName];
        if (!patterns) return { action: 'proceed' };

        const written = JSON.stringify(input);
        const offending = patterns.find((pattern) => written.includes(pattern));
        if (!offending) return { action: 'proceed' };

        // Not a skipped turn. heddle answers a refused call with a tool message
        // saying so, because a provider refuses a request whose assistant
        // message asked for a call that nothing answers — so the model reads
        // this reason and can try something else.
        return {
          action: 'reject',
          reason:
            `"${subject.toolName}" may not be called with "${offending}" on this ` +
            `host. Try something that does not need it.`,
        };
      },

      after: ({ subject, outcome }, ctx) => {
        const limit = ctx.component.maxResultBytes;
        // `=== undefined`, not falsy: a limit of 0 means "never send a result",
        // which is a setting somebody may want and not the same as no setting.
        if (limit === undefined || !outcome.ok) return { action: 'pass' };

        const written = JSON.stringify(outcome.value);
        if (written.length <= limit) return { action: 'pass' };

        ctx.log(
          'info',
          `"${subject.toolName}" returned ${written.length} bytes; replacing it ` +
            `with a note rather than sending it to the model.`,
        );
        return {
          action: 'replace',
          value: {
            omitted: true,
            bytes: written.length,
            note: `The result was too large to include. Narrow the request.`,
          },
        };
      },
    },
  },

  /**
   * A model that is not a model.
   *
   * Not part of the lesson — it is here so the tool-call demo below runs with no
   * credential. It answers the first request with a call to whatever tool the
   * flow named, and the second with a sentence, which is the shortest
   * conversation in which a tool gets called at all.
   */
  StubModelConfig: {
    chat: (request, ctx) => {
      const asked = request.messages.some((m) => m.role === 'tool');
      if (asked) {
        return { content: 'Understood, I will stop there.', finish_reason: 'stop' };
      }

      return {
        content: '',
        finish_reason: 'tool_calls',
        tool_calls: [
          {
            id: 'call_1',
            name: ctx.component.callTool ?? 'shell',
            arguments: JSON.stringify({ cmd: 'rm -rf /var/data' }),
          },
        ],
      };
    },
  },

  /**
   * Hold the whole process to a rate, and re-issue a model call that failed for
   * a reason re-issuing would fix.
   *
   * `modelCall` is the only seam that admits `retry`, and the difference is what
   * has already been said. A failed *tool* call leaves an assistant message
   * asking for it in the conversation, so re-issuing is not re-entering a clean
   * state; a failed *model* call has changed nothing, so it is.
   */
  RateLimit: {
    modelCall: {
      before: (_call, ctx) => {
        const limit = ctx.component.callsPerMinute;
        if (limit === undefined) return { action: 'proceed' };

        const now = Date.now();
        while (recentCalls.length > 0 && now - recentCalls[0] > ONE_MINUTE) {
          recentCalls.shift();
        }

        if (recentCalls.length >= limit) {
          // `reject` fails the node with this reason, which `nodeError` then
          // sees — so a RetryPolicy loaded alongside this one can decide whether
          // to wait and come back. That is the chain composing rather than one
          // middleware doing two jobs.
          return {
            action: 'reject',
            reason:
              `this host has made ${recentCalls.length} model calls in the last ` +
              `minute and allows ${limit}`,
          };
        }

        recentCalls.push(now);
        return { action: 'proceed' };
      },

      after: ({ subject, outcome }, ctx) => {
        if (outcome.ok) return { action: 'pass' };

        const { retryOn = ['429', 'timed out'], backoffMs = 1000 } =
          ctx.component;
        const worthRetrying = retryOn.some((mark) =>
          outcome.error.message.includes(mark),
        );

        if (!worthRetrying) return { action: 'pass' };

        ctx.log(
          'warn',
          `the model call for "${subject.nodeName}" failed with ` +
            `"${outcome.error.message}"; asking heddle to re-issue it`,
        );
        return { action: 'retry', delayMs: backoffMs };
      },
    },
  },
});
