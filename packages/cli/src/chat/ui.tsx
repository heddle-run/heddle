import React, { useState, useCallback, useEffect, useRef } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import TextInput from 'ink-text-input';
import {
  CHAT_HISTORY_KEY,
  Runner,
  answerOf,
  checkpointSink,
  closeTurn,
  historyFromTurns,
  isSuspended,
  messageOf,
  openTurn,
  positionOf,
  resumeInputs,
  resumeTurn,
  withoutReserved,
  type CompiledGraph,
  type RunnerOptions,
  type RunPosition,
  type Event,
  type SessionStore,
  type Turn,
} from '@heddle-run/core';
import { getToolIcon, getToolTitle, formatDuration } from './tool-display.js';

/** What a middleware suspension is asking the human, as the UI shows it. */
export type Ask = Record<string, unknown>;

/** How the chat asks the human a suspended run's question and gets an answer. */
export type Approver = (ask: Ask) => Promise<Record<string, unknown>>;

/**
 * A typed approval answer from what the human wrote at the prompt.
 *
 * `y`/`n` and their friends are the whole point — a person approving a command
 * should not have to type JSON. A raw JSON object is still accepted, for a
 * suspension whose reply is richer than yes-or-no, and anything unrecognised
 * is read as a refusal, because the safe default for "I did not understand
 * your approval" is not to approve.
 */
export function parseApproval(value: string): Record<string, unknown> {
  const word = value.trim().toLowerCase();
  if (['y', 'yes', 'approve', 'approved', 'ok', 'allow'].includes(word)) {
    return { approved: true };
  }
  if (['n', 'no', 'deny', 'denied', 'reject', 'cancel'].includes(word)) {
    return { approved: false };
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON, and not a word we know — fall through to a refusal.
  }
  return { approved: false };
}

/** One line describing what is being approved, from the suspension's ask. */
export function describeAsk(ask: Ask): string {
  const question =
    typeof ask.question === 'string' ? ask.question : 'Approve this action?';
  const detail =
    typeof ask.command === 'string'
      ? ask.command
      : typeof ask.tool === 'string'
        ? String(ask.tool)
        : undefined;
  return detail ? `${question}\n${INDENT}${detail}` : question;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 80;
const INDENT = '   ';
const SEPARATOR = '·';
const EXIT_COMMANDS = new Set(['/exit', '/quit']);

interface ToolCallEntry {
  id: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  status: 'running' | 'completed' | 'error';
  startedAt: number;
  duration?: number;
  error?: string;
}

interface MessageEntry {
  role: 'user' | 'assistant';
  content: string;
}

type ChatEntry = MessageEntry | ToolCallEntry;

/** The conversation this chat is kept in, when it is kept in one. */
export interface ChatSession {
  store: SessionStore;
  id: string;
  /** What the store already had, so the UI opens on the conversation so far. */
  turns: Turn[];
}

export interface StartChatOptions {
  graph: CompiledGraph;
  opts: RunnerOptions;
  session: ChatSession | undefined;
  flowPath: string;
  inputKey: string;
}

export function startChat(options: StartChatOptions): void {
  const instance = render(<Chat {...options} />);
  instance.waitUntilExit().catch(() => {});
}

function Chat({ graph, opts, session, flowPath, inputKey }: StartChatOptions) {
  const { exit } = useApp();
  const [history, setHistory] = useState<ChatEntry[]>(() =>
    historyFromTurns(session?.turns ?? []).map((message) => ({ ...message })),
  );
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [streamed, setStreamed] = useState('');
  const [failure, setFailure] = useState<string | undefined>();
  // The question a suspended run is waiting on, and the resolver that hands
  // the human's answer back to the turn. The resolver is a ref, not state, so
  // the submit handler reaches the current one without being rebuilt each time
  // it changes.
  const [pendingAsk, setPendingAsk] = useState<Ask | undefined>();
  const pendingResolve = useRef<((answer: Record<string, unknown>) => void) | null>(
    null,
  );

  const approve = useCallback<Approver>((ask) => {
    return new Promise((resolve) => {
      setHistory((prev) => [
        ...prev,
        { role: 'assistant', content: `⚠ ${describeAsk(ask)}` },
      ]);
      setPendingAsk(ask);
      pendingResolve.current = resolve;
    });
  }, []);

  useInput((typed, key) => {
    if (key.ctrl && typed === 'c') exit();
  });

  const hasActiveToolCall =
    running && history.some((e) => isToolCall(e) && e.status === 'running');

  const handleSubmit = useCallback(
    async (value: string) => {
      // A run waiting on approval owns the prompt. Whatever is typed is the
      // answer to its question, not a new message — routed to the resolver the
      // turn is blocked on, and the turn carries on from there.
      if (pendingResolve.current) {
        const answer = parseApproval(value);
        setHistory((prev) => [
          ...prev,
          { role: 'user', content: value.trim() || '(no answer)' },
        ]);
        setInput('');
        setPendingAsk(undefined);
        const resolve = pendingResolve.current;
        pendingResolve.current = null;
        resolve(answer);
        return;
      }

      const message = value.trim();
      if (!message || running) return;

      if (EXIT_COMMANDS.has(message)) {
        exit();
        return;
      }

      setInput('');
      setStreamed('');
      setFailure(undefined);
      setHistory((prev) => [...prev, { role: 'user', content: message }]);
      setRunning(true);

      const inputs = { [inputKey]: message };

      try {
        opts.eventHandler = (event: Event) => {
          applyEvent(event, setStreamed, setHistory);
        };

        const answer = session
          ? await runRecorded(graph, opts, session, flowPath, inputs, approve)
          : await runEphemeral(graph, opts, history, inputs);

        setHistory((prev) => [...prev, { role: 'assistant', content: answer }]);
      } catch (err) {
        // Not appended as an assistant turn: the model did not say this, and a
        // conversation that records heddle's own errors as answers feeds them
        // back to the model on the next message.
        setFailure(messageOf(err));
      } finally {
        setStreamed('');
        setRunning(false);
        setPendingAsk(undefined);
        pendingResolve.current = null;
      }
    },
    [graph, opts, session, flowPath, inputKey, running, history, exit, approve],
  );

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          heddle chat
        </Text>
        <Text dimColor> - {graph.name}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text dimColor>
          {session ? `Session: ${session.id}` : 'Not saved (add --session)'} |
          Type /exit to quit | Ctrl+C to abort
        </Text>
      </Box>

      {history.map((entry, index) => (
        <Box key={index} marginBottom={0}>
          {isToolCall(entry) ? (
            <ToolCallLine entry={entry} />
          ) : (
            <MessageLine entry={entry} />
          )}
        </Box>
      ))}

      {streamed && (
        <Box marginBottom={0}>
          <MessageLine entry={{ role: 'assistant', content: streamed }} />
        </Box>
      )}

      {running && !pendingAsk && !hasActiveToolCall && !streamed && (
        <Box marginTop={0}>
          <Text dimColor>
            {INDENT}
            <Spinner /> Thinking...
          </Text>
        </Box>
      )}

      {pendingAsk && (
        <Box marginTop={0}>
          <Text color="yellow">
            {INDENT}Waiting for you: approve? (y/n)
          </Text>
        </Box>
      )}

      {failure && (
        <Box marginTop={0}>
          <Text color="red">
            {INDENT}
            {failure}
          </Text>
        </Box>
      )}

      <Box marginTop={history.length > 0 ? 1 : 0}>
        <Text bold color={pendingAsk ? 'yellow' : 'green'}>
          {'> '}
        </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder={
            pendingAsk
              ? 'y to approve, n to deny'
              : running
                ? 'Waiting...'
                : 'Type a message...'
          }
        />
      </Box>
    </Box>
  );
}

/**
 * A turn that the store owns from both ends.
 *
 * The history comes from `openTurn` rather than from this component's state, so
 * a session picked up in a second process opens on the same conversation the
 * first one left — which is the whole difference between a transcript and a log.
 */
export async function runRecorded(
  graph: CompiledGraph,
  opts: RunnerOptions,
  session: ChatSession,
  flowPath: string,
  inputs: Record<string, unknown>,
  approve: Approver,
): Promise<string> {
  const opened = await openTurn(session.store, session.id, inputs, {
    flow: flowPath,
  });

  // The wire the non-chat run has and this one was missing: a place for a
  // suspension to be written down. Without it a middleware that stops to ask
  // a human — an approval gate, exactly what a coding agent has — fails with
  // "nowhere to be written down", even inside a session. Set, a suspend
  // checkpoints here and a success clears it.
  opts.checkpoints = checkpointSink({
    store: session.store,
    sessionId: session.id,
    runId: opened.runId,
    input: opened.input,
  });

  let started = opened.inputs;
  let from: RunPosition | undefined;

  try {
    for (;;) {
      try {
        const state = await new Runner(graph, opts).run(
          undefined,
          started,
          from,
        );
        const output = state.toData();
        await closeTurn(session.store, session.id, opened, { output });
        return answerOf(withoutReserved(output));
      } catch (err) {
        if (!isSuspended(err)) throw err;

        // Codex asks in the terminal and runs on yes; so does this. The turn
        // is not closed — it is mid-sentence — so the answer continues it from
        // the checkpoint the suspension just wrote, and a second question in
        // the same turn loops right back here.
        const answer = await approve(err.suspension.ask);
        const resumed = await resumeTurn(session.store, session.id);
        from = positionOf(resumed.checkpoint);
        started = {
          ...resumed.inputs,
          ...resumeInputs(resumed.checkpoint.suspension!, answer),
        };
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    await closeTurn(session.store, session.id, opened, {
      error: { name: error.name, message: error.message },
    });
    throw error;
  }
}

/** A conversation that lives as long as the terminal does. */
async function runEphemeral(
  graph: CompiledGraph,
  opts: RunnerOptions,
  history: ChatEntry[],
  inputs: Record<string, unknown>,
): Promise<string> {
  const conversation = history
    .filter((entry): entry is MessageEntry => !isToolCall(entry))
    .map(({ role, content }) => ({ role, content }));

  try {
    const state = await new Runner(graph, opts).run(undefined, {
      ...inputs,
      ...(conversation.length > 0 ? { [CHAT_HISTORY_KEY]: conversation } : {}),
    });
    return answerOf(withoutReserved(state.toData()));
  } catch (err) {
    // A suspension needs a checkpoint to wait in, and an unsaved chat has
    // none. Rather than the engine's "nowhere to be written down", say the one
    // thing that fixes it: this chat wants a session.
    if (isSuspended(err)) {
      throw new Error(
        `"${err.suspension.by}" wants to ask you before it runs "` +
          `${err.suspension.node}", but this chat is not saved, so there is ` +
          `nowhere for the question to wait. Restart with --session to answer ` +
          `it here.`,
      );
    }
    throw err;
  }
}

function MessageLine({ entry }: { entry: MessageEntry }) {
  const isUser = entry.role === 'user';

  return (
    <Text>
      <Text bold color={isUser ? 'green' : 'blue'}>
        {isUser ? '> ' : '< '}
      </Text>
      {entry.content}
    </Text>
  );
}

function ToolCallLine({ entry }: { entry: ToolCallEntry }) {
  const icon = getToolIcon(entry.toolName);
  const title = getToolTitle(entry.toolName, entry.toolArgs);
  const elapsed =
    entry.duration != null ? ` ${SEPARATOR} ${formatDuration(entry.duration)}` : '';

  if (entry.status === 'running') {
    return (
      <Box>
        <Text>{INDENT}</Text>
        <Spinner />
        <Text> {title}</Text>
      </Box>
    );
  }

  if (entry.status === 'error') {
    return (
      <Box>
        <Text>{INDENT}</Text>
        <Text color="red">
          {icon} {title}
          {elapsed}
        </Text>
        {entry.error && <Text color="red"> {entry.error}</Text>}
      </Box>
    );
  }

  return (
    <Box>
      <Text dimColor>
        {INDENT}
        {icon} {title}
        {elapsed}
      </Text>
    </Box>
  );
}

function Spinner() {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % SPINNER_FRAMES.length);
    }, SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  return <Text color="cyan">{SPINNER_FRAMES[frame]}</Text>;
}

function applyEvent(
  event: Event,
  setStreamed: React.Dispatch<React.SetStateAction<string>>,
  setHistory: React.Dispatch<React.SetStateAction<ChatEntry[]>>,
): void {
  if (event.type === 'node_start') {
    setStreamed('');
  }
  if (event.type === 'token_delta' && event.delta) {
    setStreamed((prev) => prev + event.delta);
  }
  if (event.type === 'tool_call' && event.toolCallId) {
    setHistory((prev) => [...prev, startedToolCall(event)]);
  }
  if (event.type === 'tool_result' && event.toolCallId) {
    setHistory((prev) => prev.map((entry) => finishToolCall(entry, event)));
  }
}

function startedToolCall(event: Event): ToolCallEntry {
  return {
    id: event.toolCallId as string,
    toolName: event.toolName as string,
    toolArgs: event.toolArgs ?? {},
    status: 'running',
    startedAt: event.startedAt ?? Date.now(),
  };
}

function finishToolCall(entry: ChatEntry, event: Event): ChatEntry {
  if (!isToolCall(entry) || entry.id !== event.toolCallId) return entry;

  return {
    ...entry,
    status: event.error ? 'error' : 'completed',
    duration: event.duration,
    error: event.error?.message,
  };
}

function isToolCall(entry: ChatEntry): entry is ToolCallEntry {
  return 'toolName' in entry;
}
