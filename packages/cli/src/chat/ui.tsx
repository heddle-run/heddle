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

function isToolCall(entry: ChatEntry): entry is ToolCallEntry {
  return 'toolName' in entry;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function Spinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, []);
  return <Text color="cyan">{SPINNER_FRAMES[frame]}</Text>;
}

function ToolCallLine({ entry }: { entry: ToolCallEntry }) {
  const icon = getToolIcon(entry.toolName);
  const title = getToolTitle(entry.toolName, entry.toolArgs);

  if (entry.status === 'running') {
    return (
      <Box>
        <Text>{'   '}</Text>
        <Spinner />
        <Text>{' '}{title}</Text>
      </Box>
    );
  }

  if (entry.status === 'error') {
    const elapsed = entry.duration != null ? ` \u00b7 ${formatDuration(entry.duration)}` : '';
    return (
      <Box>
        <Text>{'   '}</Text>
        <Text color="red">{icon} {title}{elapsed}</Text>
        {entry.error && <Text color="red">{' '}{entry.error}</Text>}
      </Box>
    );
  }

  const elapsed = entry.duration != null ? ` \u00b7 ${formatDuration(entry.duration)}` : '';
  return (
    <Box>
      <Text dimColor>{'   '}{icon} {title}{elapsed}</Text>
    </Box>
  );
}

interface ChatProps {
  graph: CompiledGraph;
  opts: RunnerOptions;
  session: ChatSession;
  inputKey: string;
}

function Chat({ graph, opts, session, inputKey }: ChatProps) {
  const { exit } = useApp();
  const [history, setHistory] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  // The answer as far as it has been streamed. Held apart from `history`
  // because it is not a message yet: it is a preview that gets thrown away
  // when the turn ends, replaced either by the node's real output or by
  // nothing at all if the run failed part way through writing it.
  const [streamed, setStreamed] = useState('');

  useInput((_input, key) => {
    if (key.ctrl && _input === 'c') {
      exit();
    }
  });

  const hasActiveToolCall = running && history.some((e) => isToolCall(e) && e.status === 'running');

  const handleSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed || running) return;

      if (trimmed === '/exit' || trimmed === '/quit') {
        exit();
        return;
      }

      setInput('');
      setStreamed('');
      setHistory((prev) => [...prev, { role: 'user', content: trimmed }]);

      // Capture previous messages before adding the current one
      const previousMessages = session.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));
      addMessage(session, 'user', trimmed);
      setRunning(true);

      try {
        const inputs: Record<string, unknown> = {
          [inputKey]: trimmed,
          _chat_history: previousMessages,
        };
        opts.eventHandler = (e: Event) => {
          // Cleared when a node starts, so a flow with two agent nodes previews
          // the second answer on its own rather than running it onto the end of
          // the first.
          if (e.type === 'node_start') {
            setStreamed('');
          }
          if (e.type === 'token_delta' && e.delta) {
            setStreamed((prev) => prev + e.delta);
          }

          if (e.type === 'tool_call' && e.toolCallId) {
            setHistory((prev) => [
              ...prev,
              {
                id: e.toolCallId!,
                toolName: e.toolName!,
                toolArgs: e.toolArgs ?? {},
                status: 'running' as const,
                startedAt: e.startedAt ?? Date.now(),
              },
            ]);
          }

          if (e.type === 'tool_result' && e.toolCallId) {
            setHistory((prev) =>
              prev.map((entry) => {
                if (isToolCall(entry) && entry.id === e.toolCallId) {
                  return {
                    ...entry,
                    status: e.error ? ('error' as const) : ('completed' as const),
                    duration: e.duration,
                    error: e.error?.message,
                  };
                }
                return entry;
              }),
            );
          }
        };
        const runner = new Runner(graph, opts);
        const result = await runner.run(undefined, inputs);

        const data = result.toData();
        const response =
          typeof data.result === 'string'
            ? data.result
            : JSON.stringify(data, null, 2);

        setHistory((prev) => [
          ...prev,
          { role: 'assistant', content: response },
        ]);
        addMessage(session, 'assistant', response);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        setHistory((prev) => [
          ...prev,
          { role: 'assistant', content: `Error: ${errMsg}` },
        ]);
        addMessage(session, 'assistant', `Error: ${errMsg}`);
      } finally {
        // Drops the preview on both paths. On success the real output has
        // just been pushed to `history` and would otherwise be shown twice;
        // on failure the partial text is not an answer and must not be left
        // on screen looking like one.
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

      {history.map((entry, i) => (
        <Box key={i} marginBottom={0}>
          {isToolCall(entry) ? (
            <ToolCallLine entry={entry} />
          ) : entry.role === 'user' ? (
            <Text>
              <Text bold color="green">
                {'> '}
              </Text>
              {entry.content}
            </Text>
          ) : (
            <Text>
              <Text bold color="blue">
                {'< '}
              </Text>
              {entry.content}
            </Text>
          )}
        </Box>
      ))}

      {streamed && (
        <Box marginBottom={0}>
          <Text>
            <Text bold color="blue">
              {'< '}
            </Text>
            {streamed}
          </Text>
        </Box>
      )}

      {running && !hasActiveToolCall && !streamed && (
        <Box marginTop={0}>
          <Text dimColor>
            {'   '}<Spinner />{' '}Thinking...
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
