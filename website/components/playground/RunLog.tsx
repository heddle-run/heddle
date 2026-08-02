"use client";

import { useEffect, useRef } from "react";
import { BUILTIN_PROTOCOL, type RunEvent } from "@/lib/playground";

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
  plugin_log: "log",
};

const FAILED = new Set(["node_error", "error"]);

const ACCENTED = new Set(["tool_call", "tool_result"]);

const PLUGIN = "plugin:";

function label(type: string): string {
  if (type.startsWith(PLUGIN)) return type.slice(type.lastIndexOf(":") + 1);
  return LABELS[type] ?? type;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

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
    case "plugin_log":
      return event.message ?? "";
    default:
      if (event.type.startsWith(PLUGIN)) {
        return event.data === undefined ? "" : JSON.stringify(event.data);
      }
      return event.type;
  }
}

/* A run reads on the same palette the landing's terminal writes in: tool
   traffic in blurple, the engine's own marks in slate, failures in red. */
const FAILED_TINT = "color-mix(in srgb, var(--red-500) 14%, transparent)";

/**
 * The run, in whichever vocabulary it arrived in.
 *
 * `describe` above reads heddle's own event types, and there is no honest way
 * to make it read another protocol's: an encoder is free to invent its
 * vocabulary, so a component that claimed to understand every one of them would
 * be guessing. Under a plugin protocol the rows become the frames themselves —
 * type first, body after — which is the one rendering that is true of any
 * encoder, and the one a reader wiring a client up actually wants.
 *
 * The two are alternatives rather than neighbours because a run is rendered in
 * exactly one protocol: the engine is handed a single encoder and the wire
 * carries what it wrote. Showing both at once would mean running twice, and
 * with a model in the flow those are two different runs — so the honest way to
 * see one flow both ways is to move the protocol and run it again.
 */
export default function RunLog({
  events,
  status,
  result,
  error,
  protocol = BUILTIN_PROTOCOL,
}: {
  events: RunEvent[];
  status: "idle" | "running" | "done" | "error";
  result?: Record<string, unknown>;
  error?: { type: string; message: string };
  protocol?: string;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const raw = protocol !== BUILTIN_PROTOCOL;

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
          alignItems: "center",
          justifyContent: "center",
          padding: "var(--space-16) var(--space-8)",
        }}
      >
        <p
          className="hds-eyebrow"
          style={{
            textAlign: "center",
            margin: 0,
            color: "var(--slate-500)",
          }}
        >
          The run appears here
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", height: "100%", flexDirection: "column" }}>
      {raw && (
        <p
          className="hds-eyebrow hds-eyebrow-inverse"
          style={{
            flexShrink: 0,
            margin: 0,
            padding: "var(--space-3) var(--space-5)",
            borderBottom: "1px solid var(--border-inverse)",
          }}
        >
          Frames · {protocol}
        </p>
      )}

      <ol
        style={{
          flex: 1,
          overflowY: "auto",
          listStyle: "none",
          margin: 0,
          padding: 0,
        }}
      >
        {events.map((event, index) =>
          raw ? (
            <FrameRow key={index} event={event} ordinal={index + 1} />
          ) : (
            <EventRow key={index} event={event} />
          ),
        )}
        <div ref={endRef} />
      </ol>

      {error && (
        <div
          style={{
            borderTop:
              "1px solid color-mix(in srgb, var(--red-500) 45%, transparent)",
            background: FAILED_TINT,
            padding: "var(--space-4) var(--space-5)",
          }}
        >
          <p
            className="hds-eyebrow"
            style={{ margin: 0, color: "var(--red-500)" }}
          >
            {error.type}
          </p>
          <p
            style={{
              margin: "var(--space-2) 0 0",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-code-sm)",
              lineHeight: "var(--lh-code)",
              overflowWrap: "break-word",
              color: "var(--code-fg)",
            }}
          >
            {error.message}
          </p>
        </div>
      )}

      {result && (
        <div style={{ borderTop: "1px solid var(--border-inverse)" }}>
          <p
            className="hds-eyebrow hds-eyebrow-inverse"
            style={{
              margin: 0,
              padding: "var(--space-3) var(--space-5)",
              borderBottom: "1px solid var(--border-inverse)",
              background: "var(--surface-code-alt)",
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
              fontSize: "var(--fs-code-sm)",
              lineHeight: "var(--lh-code)",
              color: "var(--slate-200)",
            }}
          >
            <code>{JSON.stringify(result, null, 2)}</code>
          </pre>
        </div>
      )}
    </div>
  );
}

/** One heddle event, read through the vocabulary above. */
function EventRow({ event }: { event: RunEvent }) {
  const failed =
    FAILED.has(event.type) ||
    (event.type === "plugin_log" && event.level === "error");
  const accented = ACCENTED.has(event.type);

  return (
    <Row
      marker={label(event.type)}
      tone={
        failed
          ? "var(--red-500)"
          : accented
            ? "var(--blurple-300)"
            : "var(--code-punct)"
      }
      failed={failed}
      wrap={event.type === "token_delta"}
      duration={event.duration}
    >
      {describe(event)}
    </Row>
  );
}

/**
 * One frame, as the encoder wrote it: its type, then the rest of its body.
 *
 * `parseFrame` returns a nameless frame's body unchanged, so this is the JSON
 * that crossed the wire and not a reading of it. The exception is heddle's own
 * failure frame — that one is named, so it arrives whatever the protocol, and
 * `parseFrame` moves its body to where the rest of the playground looks for an
 * error. Putting it back is what keeps this pane a record rather than a
 * paraphrase; its lowercase name among a protocol's own is the tell that it
 * came from the engine and not the encoder.
 */
function FrameRow({ event, ordinal }: { event: RunEvent; ordinal: number }) {
  const failed = event.type === "error";
  const { type, ...rest } = event;

  const body = failed
    ? JSON.stringify({ type: event.error?.type, message: event.error?.message })
    : Object.keys(rest).length > 0
      ? JSON.stringify(rest)
      : "";

  return (
    <Row marker={ordinal} tone="var(--code-punct)" failed={failed}>
      <span style={{ color: failed ? "var(--red-500)" : "var(--code-key)" }}>
        {type}
      </span>
      {body && ` ${body}`}
    </Row>
  );
}

/** The line both readings are drawn on: a marker, the text, and a duration. */
function Row({
  marker,
  tone,
  failed,
  wrap,
  duration,
  children,
}: {
  marker: React.ReactNode;
  tone: string;
  failed: boolean;
  wrap?: boolean;
  duration?: number;
  children: React.ReactNode;
}) {
  return (
    <li
      style={{
        display: "flex",
        gap: "var(--space-4)",
        padding: "var(--space-2) var(--space-5)",
        borderBottom: "1px solid var(--border-inverse)",
        background: failed ? FAILED_TINT : undefined,
        fontFamily: "var(--font-mono)",
        fontSize: "var(--fs-code-sm)",
        lineHeight: "var(--lh-code)",
        color: "var(--slate-200)",
      }}
    >
      <span
        style={{
          width: 56,
          flexShrink: 0,
          textTransform: "uppercase",
          letterSpacing: "var(--ls-label)",
          fontVariantNumeric: "tabular-nums",
          fontSize: "var(--fs-label)",
          paddingTop: 3,
          color: tone,
        }}
      >
        {marker}
      </span>
      <span
        style={{
          minWidth: 0,
          flex: 1,
          overflowWrap: "break-word",
          color: failed ? "var(--code-fg)" : "var(--slate-200)",
          whiteSpace: wrap ? "pre-wrap" : undefined,
        }}
      >
        {children}
      </span>
      {duration !== undefined && (
        <span
          style={{
            flexShrink: 0,
            fontVariantNumeric: "tabular-nums",
            color: "var(--code-punct)",
          }}
        >
          {formatDuration(duration)}
        </span>
      )}
    </li>
  );
}
