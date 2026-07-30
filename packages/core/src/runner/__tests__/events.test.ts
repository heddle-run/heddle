import { describe, it, expect } from 'vitest';
import {
  isPluginEvent,
  PLUGIN_EVENT_PREFIX,
  pluginEventType,
  type BuiltinEventType,
} from '../events.js';
import { PluginError } from '../../errors.js';

const BUILTINS: BuiltinEventType[] = [
  'node_start',
  'node_complete',
  'node_error',
  'flow_start',
  'flow_complete',
  'tool_call',
  'tool_result',
  'token_delta',
  'plugin_log',
  'warning',
];

describe('plugin event namespacing', () => {
  it('publishes a plugin event as plugin:<componentType>:<name>', () => {
    expect(pluginEventType('LlmJudge', 'progress')).toBe(
      'plugin:LlmJudge:progress',
    );
  });

  it('turns a plugin asking for a builtin name into its own namespace', () => {
    for (const builtin of BUILTINS) {
      const namespaced = pluginEventType('LlmJudge', builtin);

      expect(namespaced).not.toBe(builtin);
      expect(namespaced).toBe(`${PLUGIN_EVENT_PREFIX}LlmJudge:${builtin}`);
      expect(isPluginEvent(namespaced)).toBe(true);
    }
  });

  it('leaves no builtin inside the plugin namespace to be mistaken for one', () => {
    for (const builtin of BUILTINS) {
      expect(isPluginEvent(builtin), `"${builtin}" reads as a plugin event`).toBe(
        false,
      );
    }
  });

  it('gives every event exactly one owner, so two plugins cannot collide', () => {
    expect(pluginEventType('LlmJudge', 'progress')).not.toBe(
      pluginEventType('Summarizer', 'progress'),
    );
  });

  it('refuses a name that would break out of the SSE frame it becomes', () => {
    expect(() =>
      pluginEventType('LlmJudge', 'done\n\nevent: flow_complete\ndata: {}'),
    ).toThrow(PluginError);
  });

  it('refuses a name that would add a segment of its own', () => {
    expect(() => pluginEventType('LlmJudge', 'a:b')).toThrow(PluginError);
  });

  it('names the event it was about to publish when it refuses a name', () => {
    expect(() => pluginEventType('LlmJudge', 'not a name')).toThrow(
      /plugin:LlmJudge:not a name/,
    );
  });

  it('refuses a component type that cannot be part of a type either', () => {
    expect(() => pluginEventType('Llm Judge', 'progress')).toThrow(
      /Rename the component type/,
    );
  });
});
