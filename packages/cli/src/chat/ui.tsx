import React, { useState, useCallback, useEffect } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import TextInput from 'ink-text-input';
import {
  CHAT_HISTORY_KEY,
  Runner,
  closeTurn,
  historyFromTurns,
  openTurn,
  type CompiledGraph,
  type RunnerOptions,
  type Event,
  type SessionStore,
  type Turn,
} from '@heddle/core';
import { getToolIcon, getToolTitle, formatDuration } from './tool-display.js';

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

  useInput((typed, key) => {
    if (key.ctrl && typed === 'c') exit();
  });

  const hasActiveToolCall =
    running && history.some((e) => isToolCall(e) && e.status === 'running');

  const handleSubmit = useCallback(
    async (value: string) => {
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
          ? await runRecorded(graph, opts, session, flowPath, inputs)
          : await runEphemeral(graph, opts, history, inputs);

        setHistory((prev) => [...prev, { role: 'assistant', content: answer }]);
      } catch (err) {
        // Not appended as an assistant turn: the model did not say this, and a
        // conversation that records heddle's own errors as answers feeds them
        // back to the model on the next message.
        setFailure(err instanceof Error ? err.message : String(err));
      } finally {
        setStreamed('');
        setRunning(false);
      }
    },
    [graph, opts, session, flowPath, inputKey, running, history, exit],
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

      {running && !hasActiveToolCall && !streamed && (
        <Box marginTop={0}>
          <Text dimColor>
            {INDENT}
            <Spinner /> Thinking...
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
        <Text bold color="green">
          {'> '}
        </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder={running ? 'Waiting...' : 'Type a message...'}
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
async function runRecorded(
  graph: CompiledGraph,
  opts: RunnerOptions,
  session: ChatSession,
  flowPath: string,
  inputs: Record<string, unknown>,
): Promise<string> {
  const opened = await openTurn(session.store, session.id, inputs, {
    flow: flowPath,
  });

  try {
    const state = await new Runner(graph, opts).run(undefined, opened.inputs);
    const output = state.toData();
    await closeTurn(session.store, session.id, opened, { output });
    return answerOf(output);
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

  const state = await new Runner(graph, opts).run(undefined, {
    ...inputs,
    ...(conversation.length > 0 ? { [CHAT_HISTORY_KEY]: conversation } : {}),
  });

  return answerOf(state.toData());
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

function answerOf(data: Record<string, unknown>): string {
  return typeof data.result === 'string'
    ? data.result
    : JSON.stringify(data, null, 2);
}

function isToolCall(entry: ChatEntry): entry is ToolCallEntry {
  return 'toolName' in entry;
}
