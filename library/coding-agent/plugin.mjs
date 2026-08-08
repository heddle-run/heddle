/**
 * Codex's orchestration policies, at heddle's seams.
 *
 * Two middleware. `CodexApprovals` is the port of Codex's approval machinery
 * (codex-rs/core/src/exec_policy.rs and safety.rs): the same three policies —
 * untrusted, on-request (on-failure is an alias of it, as it is in Codex),
 * never — the same known-safe command list, the same treatment of
 * `sandbox_permissions: "require_escalated"`. `CodexContextWindow` is Codex's
 * token-budget compaction (codex-rs/core/src/compact_token_budget.rs): when
 * the conversation outgrows the window, older assistant/tool rounds are
 * dropped and a bridge message marks the cut — no summarization model call,
 * exactly like that mode.
 *
 * Where Codex asks the user inline, heddle suspends the run: the question is
 * written into the session, and the operator resumes with an answer. The
 * answer becomes the tool call's result — approval that should let the
 * command *run* is granted by resuming with a rule that allows it, which the
 * README walks through.
 */

/** Codex's known-safe commands (shell-command/src/command_safety/is_safe_command.rs). */
const SAFE = new Set([
  'cat', 'cd', 'cut', 'echo', 'expr', 'false', 'grep', 'head', 'id', 'ls',
  'nl', 'paste', 'pwd', 'rev', 'seq', 'stat', 'tail', 'tr', 'true', 'uname',
  'uniq', 'wc', 'which', 'whoami',
]);

const SAFE_GIT = new Set(['status', 'log', 'diff', 'show', 'branch']);

/** Split a shell string on && || ; | outside quotes — Codex splits sub-commands. */
function segments(command) {
  const parts = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote && command[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '&' || ch === '|' || ch === ';') {
      if (command[i + 1] === ch) i++;
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function words(segment) {
  return segment.split(/\s+/).filter(Boolean);
}

function isSafeSegment(segment) {
  const argv = words(segment);
  if (argv.length === 0) return false;
  const head = argv[0];
  if (head === 'git') return argv.length >= 2 && SAFE_GIT.has(argv[1]);
  if (head === 'sed') return argv[1] === '-n'; // sed -n Np, the guarded form
  if (head === 'find') return !segment.includes('-exec') && !segment.includes('-delete');
  if (head === 'rg' || head === 'base64') return true;
  return SAFE.has(head);
}

function isKnownSafe(command) {
  const parts = segments(command);
  return parts.length > 0 && parts.every(isSafeSegment);
}

/** Codex's dangerous-command heuristics (is_dangerous_command.rs). */
function dangerReason(command) {
  for (const segment of segments(command)) {
    const argv = words(segment);
    const head = argv[0] === 'sudo' ? argv[1] : argv[0];
    const flags = argv.filter((word) => word.startsWith('-'));
    if (head === 'rm' && flags.some((f) => /^-[a-z]*f/i.test(f) || f === '--force')) {
      return 'rm -f style commands are not permitted. Use a safer approach';
    }
    if (argv[0] === 'sudo') {
      return 'sudo is not permitted';
    }
  }
  return null;
}

function matchesRule(segment, rule) {
  const argv = words(segment);
  const prefix = rule.prefix ?? [];
  if (prefix.length === 0 || argv.length < prefix.length) return false;
  return prefix.every((word, index) => argv[index] === word);
}

/** The rule decision covering every segment, or undefined when any is uncovered. */
function ruleDecision(command, rules) {
  if (!Array.isArray(rules) || rules.length === 0) return undefined;
  const decisions = [];
  for (const segment of segments(command)) {
    const rule = rules.find((candidate) => matchesRule(segment, candidate));
    if (!rule) return undefined;
    decisions.push(rule.decision ?? 'allow');
  }
  if (decisions.includes('forbidden')) return 'forbidden';
  if (decisions.includes('prompt')) return 'prompt';
  return 'allow';
}

function policyOf(ctx) {
  const declared = ctx.component.approval_policy ?? 'on-request';
  // Codex keeps "on-failure" as a serde alias of on-request.
  return declared === 'on-failure' ? 'on-request' : declared;
}

function suspend(ask) {
  return { action: 'suspend', ask };
}

const NEVER_REFUSED =
  'approval required by policy, but AskForApproval is set to Never';

serve({
  CodexApprovals: {
    toolCall: {
      before({ subject, input }, ctx) {
        const policy = policyOf(ctx);

        if (subject.toolName === 'apply_patch') {
          // Codex's assess_patch_safety: untrusted asks, the rest trust the
          // workspace boundary the tool itself enforces (its writable root).
          if (policy === 'untrusted') {
            return suspend({
              question: 'Apply this patch?',
              reply: { approved: 'true or false' },
              how_to_allow:
                'resume with --answer {"approved":true} and the model will ' +
                're-issue it; or rerun with approval_policy "on-request"',
            });
          }
          return { action: 'proceed' };
        }

        if (subject.toolName !== 'shell_command') return { action: 'proceed' };

        const command = String(input.command ?? '');
        const escalated = input.sandbox_permissions === 'require_escalated';

        const ruled = ruleDecision(command, ctx.component.rules);
        if (ruled === 'forbidden') {
          return {
            action: 'reject',
            reason: `the operator forbids this command: ${command}`,
          };
        }
        if (ruled === 'allow' && !escalated) return { action: 'proceed' };

        if (escalated) {
          if (policy !== 'on-request') {
            // Codex's exact posture: only on-request lets the model ask.
            return {
              action: 'reject',
              reason:
                `approval policy is ${policy}; reject command — you should ` +
                'not ask for escalated permissions. Proceed another way.',
            };
          }
          if (ruled === 'allow') return { action: 'proceed' };
          ctx.emitEvent('approval_requested', { command, escalated: true });
          return suspend({
            question:
              String(input.justification ?? '') ||
              'Run this command with escalated permissions?',
            command,
            suggested_prefix_rule: input.prefix_rule ?? [],
            reply: { approved: 'true or false' },
            how_to_allow:
              'resume with --answer {"approved":true} and a --plugin-config ' +
              'CodexApprovals rule allowing this command prefix, so the ' +
              're-issued call runs',
          });
        }

        if (isKnownSafe(command)) return { action: 'proceed' };

        const danger = dangerReason(command);
        if (danger) {
          if (policy === 'never') return { action: 'reject', reason: danger };
          ctx.emitEvent('approval_requested', { command, dangerous: true });
          return suspend({
            question: `Allow a command Codex would flag (${danger})?`,
            command,
            reply: { approved: 'true or false' },
          });
        }

        if (policy === 'untrusted' && ruled !== 'prompt') {
          ctx.emitEvent('approval_requested', { command });
          return suspend({
            question: 'Allow this command? (untrusted: only known-safe reads run unasked)',
            command,
            reply: { approved: 'true or false' },
            how_to_allow:
              'resume with --answer {"approved":true} and a --plugin-config ' +
              'CodexApprovals rule allowing this command prefix',
          });
        }
        if (ruled === 'prompt') {
          if (policy === 'never') return { action: 'reject', reason: NEVER_REFUSED };
          ctx.emitEvent('approval_requested', { command });
          return suspend({
            question: 'The operator marked this command prefix "prompt". Allow it?',
            command,
            reply: { approved: 'true or false' },
          });
        }

        // on-request and never both run everything else; containment is the
        // sandbox's job, exactly as it is in Codex.
        return { action: 'proceed' };
      },
    },
  },

  CodexContextWindow: {
    modelCall: {
      before({ subject, input }, ctx) {
        const limit = ctx.component.auto_compact_limit_chars ?? 400_000;
        const messages = input.messages ?? [];
        if (JSON.stringify(messages).length < limit) return { action: 'proceed' };

        // Units that must survive: the system prompt and every user message.
        // Units that may go: an assistant message and the tool replies that
        // answer it — dropped whole, oldest first, so no tool message is ever
        // orphaned from the call that asked for it.
        const units = [];
        for (const message of messages) {
          if (message.role === 'tool' && units.length > 0) {
            units[units.length - 1].messages.push(message);
            continue;
          }
          units.push({
            keep: message.role === 'system' || message.role === 'user',
            messages: [message],
          });
        }

        let budget = Math.floor(limit / 2);
        for (let i = units.length - 1; i >= 0; i--) {
          const unit = units[i];
          const cost = JSON.stringify(unit.messages).length;
          if (unit.keep) {
            budget -= cost;
            continue;
          }
          if (budget - cost > 0) {
            budget -= cost;
            unit.keep = true;
          }
        }

        const kept = [];
        let dropped = 0;
        let bridged = false;
        for (const unit of units) {
          if (unit.keep) {
            if (dropped > 0 && !bridged) {
              bridged = true;
              kept.push({
                role: 'user',
                content:
                  '[context compacted] Earlier assistant turns and tool ' +
                  `outputs (${dropped} messages) were removed to fit the ` +
                  'context window. Every user message above is intact. Do ' +
                  'not assume file contents or command results from the ' +
                  'removed turns — re-read and re-run what you need.',
              });
            }
            kept.push(...unit.messages);
          } else {
            dropped += unit.messages.length;
          }
        }
        if (dropped === 0) return { action: 'proceed' };

        ctx.log(
          'info',
          `"${subject.nodeName}" outgrew ${limit} chars; dropped ${dropped} ` +
            'older messages, the way Codex token-budget compaction does.',
        );
        ctx.emitEvent('compacted', { dropped, limit });
        return { action: 'modify', input: { ...input, messages: kept } };
      },
    },
  },
});
