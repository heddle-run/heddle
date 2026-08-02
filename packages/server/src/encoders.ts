import {
  encoderFor,
  BUILTIN_PROTOCOL,
  PluginError,
  type PluginRegistry,
  type ResolvedEncoder,
} from '@heddle-run/core';
import { HttpError } from './errors.js';

export type ChosenEncoder = ResolvedEncoder;

export function resolveEncoder(
  protocol: string | null,
  plugins: PluginRegistry,
): ChosenEncoder {
  try {
    return encoderFor(protocol ?? BUILTIN_PROTOCOL, plugins);
  } catch (err) {
    if (!(err instanceof PluginError)) throw err;
    throw new HttpError(
      400,
      `${err.message} An encoder comes from a plugin — one this ` +
        `server has installed, or one submitted with the request — so a protocol ` +
        `nothing provides is a plugin that is neither.`,
    );
  }
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
