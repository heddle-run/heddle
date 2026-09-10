/**
 * A post transform that refuses an answer nothing in the documents supports.
 *
 * The prompt already tells the model to cite. A prompt is a request; this is
 * the gate. An answer carrying no `file:line` never reaches the caller — the
 * agent records `transform_status: "rejected"` instead, and the flow routes to
 * an ending that says the documents do not answer the question. That is the
 * honest outcome, and it is not the one a model under pressure to be helpful
 * picks on its own.
 *
 * `post` only, declared in plugin.json. On the way in there is nothing to
 * police: the question is the reader's own, on the reader's own machine, and
 * this agent's whole promise is that neither ever leaves it.
 *
 * Declared by a manifest and run as its own process, rather than imported.
 * That is what makes it shippable — an in-process plugin is a module whose
 * imports live on the machine that wrote it, and a bundle cannot carry a
 * closure.
 */

/**
 * `contract.pdf:41`, `march-statement.md:8-14`.
 *
 * The extension list is deliberately closed. An open one turns a version number
 * or a ratio into a citation, and a check that anything satisfies is not a
 * check — it is a comment.
 */
const CITATION =
  /\b[\w][\w .-]*\.(?:md|txt|csv|json|pdf|docx?|eml|rtf):\d+(?:-\d+)?\b/g;

serve({
  CitationCheck: {
    apply: (messages, ctx) => {
      const minimum = ctx.component.minCitations ?? 1;
      const answer = messages.at(-1)?.content ?? '';
      const found = [...new Set(String(answer).match(CITATION) ?? [])];

      if (found.length >= minimum) {
        ctx.emitEvent('grounded', { citations: found });
        return { action: 'pass' };
      }

      ctx.log(
        'warn',
        `the answer cites ${found.length} passage(s) and ${minimum} is required`,
      );
      return {
        action: 'reject',
        reason:
          `the answer cites ${found.length} passage(s) where ${minimum} is ` +
          `required, so nothing in the documents backs it`,
      };
    },
  },
});
