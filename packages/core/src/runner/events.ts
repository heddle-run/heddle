import type { State } from '../state/state.js';
import { PluginError } from '../errors.js';

export type BuiltinEventType =
  | 'node_start'
  | 'node_complete'
  | 'node_error'
  | 'flow_start'
  | 'flow_complete'
  | 'tool_call'
  | 'tool_result'
  | 'token_delta'
  | 'plugin_log'
  | 'warning';

export const PLUGIN_EVENT_PREFIX = 'plugin:';

export type PluginEventType = `${typeof PLUGIN_EVENT_PREFIX}${string}`;

export type EventType = BuiltinEventType | PluginEventType;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const EVENT_CONTRACT_VERSION = 1;

export interface Event {
  type: EventType;
  message?: string;
  delta?: string;
  data?: unknown;
  level?: LogLevel;
  nodeName?: string;
  nodeType?: string;
  state?: State;
  error?: Error;
  attempt?: number;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  toolCallId?: string;
  startedAt?: number;
  duration?: number;
}

export type EventHandler = (event: Event) => void;

const EVENT_TYPE_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function pluginEventType(
  componentType: string,
  name: string,
): PluginEventType {
  if (!EVENT_TYPE_SEGMENT.test(componentType)) {
    throw new PluginError(unusableComponentTypeMessage(componentType));
  }
  if (!EVENT_TYPE_SEGMENT.test(name)) {
    throw new PluginError(unusableEventNameMessage(componentType, name));
  }
  return `${PLUGIN_EVENT_PREFIX}${componentType}:${name}`;
}

export function isPluginEvent(type: EventType): type is PluginEventType {
  return type.startsWith(PLUGIN_EVENT_PREFIX);
}

function unusableComponentTypeMessage(componentType: string): string {
  return (
    `component type "${componentType}" cannot appear in an event type. heddle ` +
    `publishes a plugin's events as "${PLUGIN_EVENT_PREFIX}<componentType>:<name>", ` +
    `and every segment has to match ${EVENT_TYPE_SEGMENT.source}. Rename the component type.`
  );
}

function unusableEventNameMessage(
  componentType: string,
  name: string,
): string {
  return (
    `"${name}" is not a usable event name. This event is published as ` +
    `"${PLUGIN_EVENT_PREFIX}${componentType}:${name}", so the name is its last ` +
    `segment and has to match ${EVENT_TYPE_SEGMENT.source} — letters, digits and ` +
    `underscores, starting with a letter or underscore. Try "progress" or ` +
    `"row_written".`
  );
}
