import {
  builtinEncoder,
  BUILTIN_PROTOCOL,
  type PluginEncoder,
  type PluginRegistry,
} from '@heddle/core';
import { HttpError } from './errors.js';

export interface ChosenEncoder {
  protocol: string;
  contentType: string;
  create(runId: string): PluginEncoder;
}

const BUILTIN: ChosenEncoder = {
  protocol: BUILTIN_PROTOCOL,
  contentType: 'text/event-stream; charset=utf-8',
  create: () => builtinEncoder(),
};

export function resolveEncoder(
  protocol: string | null,
  plugins: PluginRegistry,
): ChosenEncoder {
  if (protocol === null || protocol === BUILTIN_PROTOCOL) return BUILTIN;

  const def = plugins.encoderDef(protocol);
  if (def) {
    return {
      protocol,
      contentType: def.contentType,
      create: (runId) => def.createEncoder(runId),
    };
  }

  const available = [BUILTIN_PROTOCOL, ...plugins.encoderProtocols()];
  throw new HttpError(
    400,
    `no encoder for protocol "${protocol}". This server renders: ` +
      `${available.join(', ')}. An encoder comes from a plugin — one this ` +
      `server has installed, or one submitted with the request — so a protocol ` +
      `nothing provides is a plugin that is neither.`,
  );
}

export function requireStreamFor(
  protocol: string | null,
  stream: boolean,
): void {
  if (stream || protocol === null) return;

  throw new HttpError(
    400,
    `"protocol=${protocol}" selects how this run's events are rendered, but ` +
      `"stream=true" was not set — the buffered response is one JSON body and ` +
      `carries no events at all. Add "?stream=true", or drop the protocol.`,
  );
}
