/**
 * What an operator installs around this agent. Three components, and the thing
 * to notice about all three is that the spec names none of them.
 *
 *   heddle run runbook.heddle \
 *     --plugin ./policies.json \
 *     --plugin-config ChangeApproval='{"tools":["restart_service","scale_service"]}' \
 *     --protocol audit \
 *     --session incident-4471 > incident.jsonl
 *
 * The author of the flow chose what the agent can reach. Whoever runs it
 * chooses what it may do unsupervised and what gets written down. That split is
 * the reason a middleware is a different kind of component from a node, and it
 * is why a stricter team can be handed this same bundle with different flags
 * rather than a fork of it.
 */

/**
 * A mutating call stops and waits for a person.
 *
 * `suspend`, not `reject`. A rejection is a gate that always says no: the model
 * is told and carries on. Suspending writes the run into its session and stops
 * the process, so the yes can arrive from another terminal, another machine, or
 * an hour later from somebody's phone — which is what an approval at 2am
 * actually looks like.
 */
const ChangeApproval = {
  toolCall: {
    before: ({ subject, input }, ctx) => {
      const gated = ctx.component.tools ?? [];
      if (!gated.includes(subject.toolName)) return { action: 'proceed' };

      // An operator can pre-authorise a blast radius rather than each call:
      // restarts in staging are somebody's Tuesday, in production they are not.
      const auto = ctx.component.auto_approve ?? {};
      const environment = String(input.environment ?? '');
      if (Array.isArray(auto.environments) && auto.environments.includes(environment)) {
        ctx.emitEvent('auto_approved', {
          tool: subject.toolName,
          environment,
          arguments: input,
        });
        return { action: 'proceed' };
      }

      ctx.emitEvent('awaiting_approval', {
        tool: subject.toolName,
        arguments: input,
      });
      ctx.log('warn', `"${subject.toolName}" needs a person; suspending the run`);

      return {
        action: 'suspend',
        ask: {
          question: `Approve ${subject.toolName} in ${environment || 'production'}?`,
          arguments: input,
          // What the answer has to look like. heddle prints this to whoever is
          // holding the session, and hands the answer back as the call's result.
          reply: { approved: 'true or false', note: 'why — it goes in the log' },
        },
      };
    },
  },
};

/**
 * Every node and every tool call, as events.
 *
 * `node` is the widest seam — consulted around every node of every flow — which
 * is what makes an audit a subscription rather than a change to the agent.
 * Nothing in the spec knows it is being watched, and that is the property an
 * auditor actually wants.
 *
 * It watches and changes nothing: every hook returns `pass` or `proceed`,
 * including around a failure, so the rest of the chain still gets its say. The
 * events land in the run's event stream, which the `audit` encoder below turns
 * into a file.
 */
const AuditTrail = {
  node: {
    after: ({ subject, outcome }, ctx) => {
      ctx.emitEvent('node', {
        node: subject.nodeName,
        type: subject.nodeType,
        ok: outcome.ok,
        attempt: ctx.attempt,
      });
      return { action: 'pass' };
    },
  },

  toolCall: {
    before: ({ subject, input }, ctx) => {
      ctx.emitEvent('call', { tool: subject.toolName, arguments: input });
      return { action: 'proceed' };
    },

    after: ({ subject, outcome }, ctx) => {
      // The result itself is not recorded. An audit log that copies every byte
      // a tool returned is a second copy of production data in a file nobody is
      // guarding — the record that matters is what was attempted, by what, and
      // whether it worked.
      ctx.emitEvent('result', {
        tool: subject.toolName,
        ok: outcome.ok,
        error: outcome.ok ? undefined : String(outcome.error?.message ?? ''),
      });
      return { action: 'pass' };
    },
  },
};

/**
 * The run as one JSON object per line.
 *
 * An encoder is chosen at the command line too — `--protocol audit` — and it
 * replaces the human progress output rather than adding to it. Redirect stdout
 * and the incident has a file: what ran, what was called with what, what a
 * person approved, and when each of those happened.
 *
 * Token deltas are dropped. An audit wants the record of what was done, and a
 * per-token transcript of the model thinking out loud is neither evidence nor
 * something to keep.
 */
const AuditLog = {
  encode: (event, ctx) => {
    if (event.type === 'token_delta') return [];

    const line = {
      at: new Date().toISOString(),
      run: ctx.runId,
      event: event.type,
    };

    if (event.nodeName) line.node = event.nodeName;
    if (event.toolName) line.tool = event.toolName;
    if (event.toolArgs) line.arguments = event.toolArgs;
    if (event.message) line.message = event.message;
    if (event.level) line.level = event.level;
    if (event.data !== undefined) line.data = event.data;
    if (event.error) line.error = String(event.error.message ?? event.error);

    return [{ data: line }];
  },

  finish: (ctx) => [
    { data: { at: new Date().toISOString(), run: ctx.runId, event: 'audit_closed' } },
  ],
};

serve({ ChangeApproval, AuditTrail, AuditLog });
