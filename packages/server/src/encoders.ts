/**
 * Choosing how a run is rendered for the client that asked for it.
 *
 * The selector is `?protocol=`, beside the `?stream=` that already decides
 * whether there are frames at all. Both are query parameters rather than headers
 * for the same reason: they are properties of the run being requested, they show
 * up in a log and in a URL somebody can paste, and `Accept` could not do this
 * job anyway — heddle's own frames and AG-UI's are both `text/event-stream`, so
 * a media type cannot choose between two renderings that share a carrier.
 */
import {
  builtinEncoder,
  BUILTIN_PROTOCOL,
  type PluginEncoder,
  type PluginRegistry,
} from '@heddle/core';
import { HttpError } from './errors.js';

/** An encoder chosen for one run, with the header its frames travel under. */
export interface ChosenEncoder {
  protocol: string;
  contentType: string;
  create(runId: string): PluginEncoder;
}

/** heddle's own rendering: the answer when a request asks for nothing else. */
const BUILTIN: ChosenEncoder = {
  protocol: BUILTIN_PROTOCOL,
  contentType: 'text/event-stream; charset=utf-8',
  create: () => builtinEncoder(),
};

/**
 * Resolve the protocol a request asked for.
 *
 * heddle's own name is matched **first and unconditionally**, before the
 * registry is consulted — the same order `providerFor` uses for a builtin
 * `llm_config` type, and the same guarantee. `PluginRegistry.claimProtocol`
 * already refuses a plugin that declares `heddle`, so this is the second lock
 * rather than the first, and either alone would be a rule that holds until
 * someone reorders something.
 *
 * An unknown protocol is a 400 that lists what this server can render. The
 * alternative — falling back to heddle's own frames — is the failure mode that
 * costs the most to debug: a client asking for `ag-ui`, receiving well-formed
 * frames of a protocol it does not speak, and reporting that AG-UI is broken.
 */
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
      `${available.join(', ')}. An encoder is submitted with the request as a ` +
      `plugin, so a protocol nothing provides is a plugin that was not sent.`,
  );
}

/**
 * Refuse a rendering of a stream that was not asked for.
 *
 * `?protocol=ag-ui` without `?stream=true` asks for a rendering of a run's
 * events on a response that carries none — the buffered path returns one JSON
 * body and emits nothing. Refused rather than ignored, for `rejectServerSideFields`'s
 * reason: a caller who believes they selected a protocol, and is not told
 * otherwise, has been misled about what they are about to parse.
 *
 * **`heddle` is refused here too, even though it is the default.** Naming a
 * protocol is a claim about the response body, and that claim is equally wrong
 * whichever protocol was named — a client that wrote `?protocol=heddle` and
 * received one JSON object was misled by exactly as much. Saying nothing is the
 * only way to get the buffered response, which keeps the rule "a protocol you
 * named is a protocol you will receive" true with no exceptions to remember.
 */
export function requireStreamFor(protocol: string | null, stream: boolean): void {
  if (stream || protocol === null) return;
  throw new HttpError(
    400,
    `"protocol=${protocol}" selects how this run's events are rendered, but ` +
      `"stream=true" was not set — the buffered response is one JSON body and ` +
      `carries no events at all. Add "?stream=true", or drop the protocol.`,
  );
}
