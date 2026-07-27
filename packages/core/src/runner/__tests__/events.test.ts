/**
 * The rule that lets a plugin emit events without letting it lie.
 *
 * `EventType` used to be closed, so the question did not arise. Now half of it
 * is a plugin's to fill in, and the property that has to survive every future
 * change is this one: a plugin cannot produce an event a client will read as
 * heddle's own. These tests are that property, stated three ways — the format,
 * the disjointness in both directions, and the two ways a name could otherwise
 * escape the type it is embedded in.
 */
import { describe, it, expect } from 'vitest';
import {
  isPluginEvent,
  PLUGIN_EVENT_PREFIX,
  pluginEventType,
  type BuiltinEventType,
} from '../events.js';
import { PluginError } from '../../errors.js';

/**
 * Every event heddle emits on its own account, written out rather than derived.
 * A type added to the union without being added here leaves the forgery tests
 * below passing while no longer covering it.
 */
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
    // The event type is written to the wire as the SSE event name, unescaped.
    // Were this accepted, the newline would end the frame and the rest would be
    // read as a `flow_complete` of the plugin's own composition.
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
    // A manifest already enforces this shape, so reaching it means an
    // in-process plugin declared a component type no remote one could.
    expect(() => pluginEventType('Llm Judge', 'progress')).toThrow(
      /Rename the component type/,
    );
  });
});
