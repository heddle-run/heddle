import {
  encoderFor,
  PluginError,
  type PluginEncoder,
  type PluginRegistry,
  type WireFrame,
} from '@heddle/core';

export type EncoderFactory = (runId: string) => PluginEncoder;

export function resolveEncoder(
  protocol: string,
  plugins: PluginRegistry,
): EncoderFactory {
  try {
    // `contentType` is deliberately dropped: it is the header a *server* sends,
    // and nothing here is serving HTTP. Carrying it would be a field nothing reads.
    return encoderFor(protocol, plugins).create;
  } catch (err) {
    if (!(err instanceof PluginError)) throw err;
    throw new Error(
      `${err.message} An encoder comes from a plugin, and the only ` +
        `plugins a run has are the ones --plugin loaded — so a protocol nothing ` +
        `provides is a --plugin that is missing.`,
    );
  }
}

/**
 * One frame per line, written as the frame itself rather than its payload.
 *
 * SSE's `event:`/`data:` framing is how an HTTP *response body* carries a name
 * beside a payload, and stdout is not a response body — a blank-line-delimited
 * record is awkward for every line-oriented reader a shell has, and `jq` reads
 * JSON Lines with no argument at all. Writing the whole frame keeps the two
 * shapes distinguishable: heddle's own frames name the type in `event`, AG-UI
 * puts it inside `data` and leaves `event` unset, and a line carrying only the
 * payload would render those two identically.
 */
export function frameLine(frame: WireFrame): string {
  const line =
    frame.event === undefined
      ? { data: frame.data }
      : { event: frame.event, data: frame.data };
  return `${JSON.stringify(line)}\n`;
}
