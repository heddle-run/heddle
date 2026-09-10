/**
 * The contract between an agent and an automation, enforced.
 *
 * A Shortcut is not a person. It reads one field out of the answer and acts on
 * it, and a model that decides today to wrap its JSON in a friendly sentence
 * has broken an automation that then fails silently at 7am — the reminder
 * simply never appears. So the shape is checked on the way out rather than
 * hoped for: an answer that is not exactly the object the Shortcut consumes is
 * rejected, the agent records `transform_status: "rejected"`, and the flow ends
 * somewhere that says so.
 *
 * One file, no imports, no `command` in the manifest. That is what keeps the
 * bundle runnable inside the phone's own JavaScript engine, which is the whole
 * point of an agent you fire from a share sheet.
 */

const ACTIONS = ['reminder', 'note', 'nothing'];

/** The model's answer as an object, or null if it is not one. */
function parsed(text) {
  const trimmed = String(text ?? '').trim();
  // A fenced block is the most common near-miss and the cheapest to forgive.
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const value = JSON.parse(unfenced);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

serve({
  CaptureShape: {
    apply: (messages, ctx) => {
      const limit = ctx.component.maxSummary ?? 120;
      const last = messages.at(-1);
      const answer = parsed(last?.content);

      if (answer === null) {
        return {
          action: 'reject',
          reason: 'the answer is not a JSON object, so no automation can read it',
        };
      }

      if (!ACTIONS.includes(answer.action)) {
        return {
          action: 'reject',
          reason:
            `"action" is ${JSON.stringify(answer.action)} and must be one of ` +
            ACTIONS.join(', '),
        };
      }

      if (typeof answer.summary !== 'string' || !answer.summary.trim()) {
        return {
          action: 'reject',
          reason: '"summary" is missing, and it is the line the Shortcut shows',
        };
      }

      // A reminder with no title is a line in the list that says nothing, which
      // is worse than no reminder at all.
      if (
        answer.action === 'reminder' &&
        (typeof answer.title !== 'string' || !answer.title.trim())
      ) {
        return {
          action: 'reject',
          reason: 'a reminder needs a "title" — it is what appears in the list',
        };
      }

      // Long is not wrong, so this is trimmed rather than refused.
      if (answer.summary.length > limit) {
        ctx.log('info', `summary trimmed to ${limit} characters`);
        const trimmed = {
          ...answer,
          summary: `${answer.summary.slice(0, limit - 1)}…`,
        };
        return {
          action: 'modify',
          messages: [
            ...messages.slice(0, -1),
            { ...last, content: JSON.stringify(trimmed) },
          ],
        };
      }

      ctx.emitEvent('shape_ok', { action: answer.action });
      return { action: 'pass' };
    },
  },
});
