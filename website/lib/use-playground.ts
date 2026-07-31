"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  API_BASE,
  BUILTIN_PROTOCOL,
  DEFAULT_EXAMPLE,
  EngineError,
  appendEvent,
  encoderProtocols,
  fetchCapabilities,
  streamRun,
  validateFlow,
  type Capabilities,
  type Example,
  type RequestPlugin,
  type RequestTool,
  type RunEvent,
} from "./playground";

export type Status = "idle" | "running" | "done" | "error";

export type Playground = ReturnType<typeof usePlayground>;

/**
 * Everything the editor holds: the spec being written, the run it produced,
 * and what the engine says it will accept.
 *
 * It lives here rather than in the component because the comparison is the
 * other half of the same page. Switching to it unmounts the editor, and a
 * reader who came back to find their spec replaced by the default example
 * would rightly call that a bug.
 */
export function usePlayground() {
  const [example, setExample] = useState<Example>(DEFAULT_EXAMPLE);
  const [flow, setFlow] = useState(DEFAULT_EXAMPLE.flow);
  const [inputs, setInputs] = useState(DEFAULT_EXAMPLE.inputs);
  const [tools, setTools] = useState<RequestTool[]>(DEFAULT_EXAMPLE.tools);
  const [plugins, setPlugins] = useState<RequestPlugin[]>(
    DEFAULT_EXAMPLE.plugins,
  );

  const [protocol, setProtocol] = useState(
    DEFAULT_EXAMPLE.protocol ?? BUILTIN_PROTOCOL,
  );

  const [tab, setTab] = useState("spec");
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [renderedIn, setRenderedIn] = useState(BUILTIN_PROTOCOL);
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<Record<string, unknown>>();
  const [error, setError] = useState<{ type: string; message: string }>();
  const [capabilities, setCapabilities] = useState<Capabilities>();
  const [reachable, setReachable] = useState<boolean>();

  const abortRef = useRef<AbortController>(null);

  useEffect(() => {
    const ac = new AbortController();
    fetchCapabilities(ac.signal)
      .then((caps) => {
        setCapabilities(caps);
        setReachable(true);
      })
      .catch((err: unknown) => {
        if ((err as Error)?.name !== "AbortError") setReachable(false);
      });
    return () => ac.abort();
  }, []);

  const readInputs = useCallback((): Record<string, unknown> => {
    const text = inputs.trim();
    if (!text) return {};
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new SyntaxError("Inputs must be a JSON object.");
    }
    return parsed as Record<string, unknown>;
  }, [inputs]);

  /* The renderings this request could ask for. heddle's own is always one of
     them; the rest come from encoders the submitted plugins declare, because
     the engine has not heard of a protocol until it is sent the plugin that
     provides it — so this reads the manifests here rather than /v1/capabilities.

     It follows the plugins, and the choice has to follow it: deleting the
     encoder from the Plugins tab while its protocol was selected would
     otherwise leave the run asking for a rendering nothing provides, which is
     a 400 rather than a fallback. */
  const protocols = useMemo(
    () => [BUILTIN_PROTOCOL, ...encoderProtocols(plugins)],
    [plugins],
  );
  const chosen = protocols.includes(protocol) ? protocol : BUILTIN_PROTOCOL;

  const payload = useCallback(
    () => ({ flow, inputs: readInputs(), tools, plugins, protocol: chosen }),
    [flow, readInputs, tools, plugins, chosen],
  );

  const fail = (err: unknown) => {
    if (err instanceof EngineError) {
      setError({ type: err.type, message: err.message });
    } else if (err instanceof SyntaxError) {
      setError({ type: "InvalidInputs", message: err.message });
    } else if ((err as Error)?.name === "AbortError") {
      setError({ type: "Aborted", message: "Run stopped." });
    } else {
      setError({
        type: "NetworkError",
        message:
          `Could not reach the engine at ${API_BASE || "(not configured)"}. ` +
          "It may be down, or it may not allow this origin.",
      });
    }
    setStatus("error");
  };

  const reset = () => {
    setEvents([]);
    setResult(undefined);
    setError(undefined);
  };

  const run = async () => {
    reset();
    /* Recorded when the run starts rather than read while rendering. The pane
       has to describe the events it is holding, and a reader who moves the
       protocol afterwards would otherwise see this run relabelled as the one
       they have not made yet. */
    setRenderedIn(chosen);
    setStatus("running");

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      for await (const event of streamRun(payload(), ac.signal)) {
        setEvents((previous) => appendEvent(previous, event));

        if (event.type === "flow_complete" && event.state) {
          setResult(event.state);
        }
        if (event.type === "error") {
          setError({
            type: event.error?.type ?? event.error?.name ?? "Error",
            message: event.error?.message ?? "the run failed",
          });
        }
      }
      setStatus((current) => (current === "error" ? current : "done"));
    } catch (err) {
      fail(err);
    } finally {
      abortRef.current = null;
    }
  };

  const stop = () => abortRef.current?.abort();

  const check = async () => {
    reset();
    /* Validation runs nothing, so there is no stream and no encoder: the rows
       below are heddle's own vocabulary whatever the protocol says. */
    setRenderedIn(BUILTIN_PROTOCOL);
    setStatus("running");
    try {
      const validation = await validateFlow(payload());
      setEvents([
        { type: "flow_start" },
        ...validation.nodes.map((node) => ({
          type: "node_start",
          nodeName: node.name,
          nodeType: node.type,
        })),
        { type: "flow_complete" },
      ]);
      setResult({
        valid: true,
        flow: validation.flow,
        startNode: validation.startNode,
        nodes: validation.nodes.length,
      });
      setStatus("done");
    } catch (err) {
      fail(err);
    }
  };

  const load = (next: Example) => {
    setExample(next);
    setFlow(next.flow);
    setInputs(next.inputs);
    setTools(next.tools);
    setPlugins(next.plugins);
    setProtocol(next.protocol ?? BUILTIN_PROTOCOL);
    setTab("spec");
    reset();
    setStatus("idle");
  };

  const restore = () => load(example);

  return {
    example,
    flow,
    setFlow,
    inputs,
    setInputs,
    tools,
    setTools,
    plugins,
    setPlugins,
    protocol: chosen,
    setProtocol,
    protocols,
    renderedIn,
    tab,
    setTab,
    events,
    status,
    result,
    error,
    capabilities,
    reachable,
    run,
    stop,
    check,
    load,
    restore,
    busy: status === "running",
    codeAllowed: capabilities?.allowRequestCode ?? true,
    limits: capabilities?.limits,
  };
}
