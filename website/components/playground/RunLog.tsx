"use client";

import { useEffect, useRef } from "react";
import type { RunEvent } from "@/lib/playground";

/** Runner event names, rendered as fixed-width mono labels. */
const LABELS: Record<string, string> = {
  flow_start: "flow",
  flow_complete: "flow",
  node_start: "node",
  node_complete: "node",
  node_error: "error",
  tool_call: "call",
  tool_result: "result",
  token_delta: "text",
  warning: "warn",
  error: "error",
};

/** Events that mark a failure. */
const FAILED = new Set(["node_error", "error"]);

/** Tool traffic is the interesting part of a run, so it takes the accent. */
const ACCENTED = new Set(["tool_call", "tool_result"]);

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** The one-line description of an event. */
function describe(event: RunEvent): string {
  switch (event.type) {
    case "flow_start":
      return "started";
    case "flow_complete":
      return "completed";
    case "node_start":
      return `${event.nodeName} · ${event.nodeType}`;
    case "node_complete":
      return `${event.nodeName}`;
    case "node_error":
      return `${event.nodeName}: ${event.error?.message ?? "failed"}`;
    case "tool_call":
      return `${event.toolName}(${JSON.stringify(event.toolArgs ?? {})})`;
    case "tool_result":
      return event.error
        ? `${event.toolName}: ${event.error.message}`
        : `${event.toolName} → ${JSON.stringify(event.toolResult ?? {})}`;
    case "token_delta":
      return event.delta ?? "";
    case "warning":
      return event.message ?? "";
    case "error":
      return event.error?.message ?? event.message ?? "failed";
    default:
      return event.type;
  }
}

export default function RunLog({
  events,
  status,
  result,
  error,
}: {
  events: RunEvent[];
  status: "idle" | "running" | "done" | "error";
  result?: Record<string, unknown>;
  error?: { type: string; message: string };
}) {
  const endRef = useRef<HTMLDivElement>(null);

  // Follow the tail while a run is in flight. Only during a run, so reading
  // back through a finished log is not fought by an autoscroll.
  //
  // Keyed on the list itself and not its length: a streamed answer grows inside
  // its own entry without adding one, so a length would sit still through the
  // longest thing the log ever has to follow.
  useEffect(() => {
    if (status === "running") {
      endRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [events, status]);

  if (status === "idle" && events.length === 0) {
    return (
      <div
        style={{
          display: "flex",
          height: "100%",
          minHeight: "24rem",
          alignItems: "center",
          justifyContent: "center",
          padding: "var(--space-16) var(--space-8)",
        }}
      >
        <p className="hd-eyebrow" style={{ textAlign: "center", margin: 0 }}>
          The run appears here
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", height: "100%", flexDirection: "column" }}>
      <ol
        style={{
          flex: 1,
          overflowY: "auto",
          listStyle: "none",
          margin: 0,
          padding: 0,
        }}
      >
        {events.map((event, index) => {
          const failed = FAILED.has(event.type);
          const accented = ACCENTED.has(event.type);
          return (
            <li
              key={index}
              style={{
                display: "flex",
                gap: "var(--space-4)",
                padding: "var(--space-2) var(--space-5)",
                borderBottom: "1px solid var(--border-hairline)",
                background: failed ? "var(--brand-pink-05)" : undefined,
                fontFamily: "var(--font-mono)",
                fontSize: "var(--fs-xs)",
                lineHeight: "var(--lh-relaxed)",
                color: "var(--text-body)",
              }}
            >
              <span
                style={{
                  width: 56,
                  flexShrink: 0,
                  textTransform: "uppercase",
                  letterSpacing: "var(--tracking-widest)",
                  fontSize: "var(--fs-2xs)",
                  paddingTop: 2,
                  color: failed
                    ? "var(--hue-red)"
                    : accented
                      ? "var(--brand-pink)"
                      : "var(--text-faint)",
                }}
              >
                {LABELS[event.type] ?? event.type}
              </span>
              <span
                style={{
                  minWidth: 0,
                  flex: 1,
                  overflowWrap: "break-word",
                  color: failed ? "var(--text-strong)" : "var(--text-body)",
                  // A model's answer carries its own line breaks, and every
                  // other row is a single line that has none to lose.
                  whiteSpace:
                    event.type === "token_delta" ? "pre-wrap" : undefined,
                }}
              >
                {describe(event)}
              </span>
              {event.duration !== undefined && (
                <span
                  style={{
                    flexShrink: 0,
                    fontVariantNumeric: "tabular-nums",
                    color: "var(--text-faint)",
                  }}
                >
                  {formatDuration(event.duration)}
                </span>
              )}
            </li>
          );
        })}
        <div ref={endRef} />
      </ol>

      {error && (
        <div
          style={{
            borderTop: "1px solid var(--brand-pink-30)",
            background: "var(--brand-pink-05)",
            padding: "var(--space-4) var(--space-5)",
          }}
        >
          <p
            className="hd-eyebrow"
            style={{ margin: 0, color: "var(--brand-pink)" }}
          >
            {error.type}
          </p>
          <p
            style={{
              margin: "var(--space-2) 0 0",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-xs)",
              lineHeight: "var(--lh-relaxed)",
              overflowWrap: "break-word",
              color: "var(--text-strong)",
            }}
          >
            {error.message}
          </p>
        </div>
      )}

      {result && (
        <div style={{ borderTop: "1px solid var(--border-default)" }}>
          <p
            className="hd-eyebrow"
            style={{
              margin: 0,
              padding: "var(--space-3) var(--space-5)",
              borderBottom: "1px solid var(--border-hairline)",
            }}
          >
            Final state
          </p>
          <pre
            style={{
              margin: 0,
              maxHeight: "16rem",
              overflow: "auto",
              padding: "var(--space-4) var(--space-5)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-xs)",
              lineHeight: "var(--lh-relaxed)",
              color: "var(--text-body)",
            }}
          >
            <code>{JSON.stringify(result, null, 2)}</code>
          </pre>
        </div>
      )}
    </div>
  );
}
