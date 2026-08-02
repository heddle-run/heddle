import { describe, it, expect } from 'vitest';
import { historyMessages, readHistory } from '../history.js';
import { CHAT_HISTORY_KEY, isReservedStateKey } from '../reserved.js';

describe('the chat-history contract', () => {
  it('reserves the history key and no ordinary input', () => {
    expect(isReservedStateKey(CHAT_HISTORY_KEY)).toBe(true);
    expect(isReservedStateKey('query')).toBe(false);
  });

  it('reads an absent history as no conversation, not as a fault', () => {
    expect(readHistory(undefined)).toEqual([]);
    expect(readHistory(null)).toEqual([]);
  });

  it('keeps the turns in the order they were given', () => {
    const turns = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ];

    expect(readHistory(turns)).toEqual(turns);
  });

  it('drops nothing a turn carries beyond role and content', () => {
    const read = readHistory([
      { role: 'user', content: 'hi', at: '2026-01-01T00:00:00Z', runId: 'r1' },
    ]);

    expect(read).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('names the offending turn when one is malformed', () => {
    expect(() =>
      readHistory([{ role: 'user', content: 'ok' }, { role: 'user' }]),
    ).toThrow(/"_chat_history"\[1\] has no "content" string/);
  });

  it('refuses a role that is not part of a conversation', () => {
    expect(() => readHistory([{ role: 'system', content: 'be nice' }])).toThrow(
      /a history turn is "user" or "assistant"/,
    );
    expect(() =>
      readHistory([{ role: 'tool', content: '{}', tool_call_id: 'c1' }]),
    ).toThrow(/answers a call this run never made/);
  });

  it('refuses a history that is not a list of turns', () => {
    expect(() => readHistory('yesterday we spoke')).toThrow(
      /is a string, expected an array/,
    );
    expect(() => readHistory({ 0: { role: 'user', content: 'hi' } })).toThrow(
      /is a object, expected an array/,
    );
  });

  it('hands an agent messages it can put in front of its own turn', () => {
    expect(
      historyMessages([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ]),
    ).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });
});
