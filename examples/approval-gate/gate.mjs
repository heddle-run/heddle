/**
 * A tool call that a person has to approve.
 *
 * Twelve lines of policy, and the interesting part is which verdict it returns.
 *
 * `reject` was always available: the model is told the call was refused and
 * carries on, which is a gate that always says no. `suspend` is the other half
 * — the run stops, is written into its session, and starts again when somebody
 * answers. The difference is not how emphatic the refusal is; it is whether
 * there is a way to say yes later.
 *
 * What comes back is the answer, verbatim, as the tool's result. The model sees
 * `{"approved": true}` where it expected the tool's output — which is why a
 * gate like this belongs on tools whose result the agent only checks, and why a
 * gate that wants the tool to *actually run* after approval is a different
 * design (approve the arguments, not the result).
 */
serve({
  ApprovalGate: {
    toolCall: {
      before({ subject, input }, ctx) {
        const gated = ctx.component.tools ?? [];
        if (!gated.includes(subject.toolName)) return { action: 'proceed' };

        // Everything the person needs to decide. heddle adds the tool name and
        // the arguments on its own, so this is what *this policy* wants asked.
        return {
          action: 'suspend',
          ask: {
            question: `Approve ${subject.toolName}?`,
            arguments: input,
            reply: { approved: 'true or false' },
          },
        };
      },
    },
  },
});
