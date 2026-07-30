import React, { useState, useCallback, useEffect } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import TextInput from 'ink-text-input';
import {
  Runner,
  type CompiledGraph,
  type RunnerOptions,
  type Event,
} from '@heddle/core';
import type { ChatSession } from './session.js';
import { addMessage } from './session.js';
import { getToolIcon, getToolTitle, formatDuration } from './tool-display.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 80;
const INDENT = '   ';
const SEPARATOR = '·';
const EXIT_COMMANDS = new Set(['/exit', '/quit']);
const CHAT_HISTORY_KEY = '_chat_history';

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

export interface StartChatOptions {
  graph: CompiledGraph;
  opts: RunnerOptions;
  session: ChatSession;
  inputKey: string;
}

export function startChat({
  graph,
  opts,
  session,
  inputKey,
}: StartChatOptions): void {
  const instance = render(
    <Chat graph={graph} opts={opts} session={session} inputKey={inputKey} />,
  );
  instance.waitUntilExit().catch(() => {});
}

function Chat({ graph, opts, session, inputKey }: StartChatOptions) {
  const { exit } = useApp();
  const [history, setHistory] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [streamed, setStreamed] = useState('');

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
      setHistory((prev) => [...prev, { role: 'user', content: message }]);

      const previousMessages = session.messages.map((entry) => ({
        role: entry.role,
        content: entry.content,
      }));
      addMessage(session, 'user', message);
      setRunning(true);

      try {
        opts.eventHandler = (event: Event) => {
          applyEvent(event, setStreamed, setHistory);
        };

        const runner = new Runner(graph, opts);
        const result = await runner.run(undefined, {
          [inputKey]: message,
          [CHAT_HISTORY_KEY]: previousMessages,
        });

        recordAssistantReply(session, setHistory, formatResult(result.toData()));
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        recordAssistantReply(session, setHistory, `Error: ${detail}`);
      } finally {
        setStreamed('');
        setRunning(false);
      }
    },
    [graph, opts, session, inputKey, running, exit],
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
          Session: {session.id} | Type /exit to quit | Ctrl+C to abort
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

function recordAssistantReply(
  session: ChatSession,
  setHistory: React.Dispatch<React.SetStateAction<ChatEntry[]>>,
  content: string,
): void {
  setHistory((prev) => [...prev, { role: 'assistant', content }]);
  addMessage(session, 'assistant', content);
}

function formatResult(data: Record<string, unknown>): string {
  return typeof data.result === 'string'
    ? data.result
    : JSON.stringify(data, null, 2);
}

function isToolCall(entry: ChatEntry): entry is ToolCallEntry {
  return 'toolName' in entry;
}
