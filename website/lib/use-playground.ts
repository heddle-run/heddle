"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  API_BASE,
  DEFAULT_EXAMPLE,
  EngineError,
  appendEvent,
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

  const [tab, setTab] = useState("spec");
  const [events, setEvents] = useState<RunEvent[]>([]);
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

  const payload = useCallback(
    () => ({ flow, inputs: readInputs(), tools, plugins }),
    [flow, readInputs, tools, plugins],
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
