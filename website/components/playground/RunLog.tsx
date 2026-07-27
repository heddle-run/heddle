"use client";

import { useEffect, useMemo, useRef } from "react";
import type { RunEvent } from "@/lib/playground";
import { cn } from "@/lib/cn";

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

/**
 * Fold a node's streamed answer back into one row.
 *
 * A `token_delta` arrives per fragment, so rendering the event list directly
 * gives one row per token — a few hundred rows for one answer, which is what
 * this collapse exists to prevent.
 *
 * Only *consecutive* deltas from the same node merge. A tool call landing
 * between two stretches of an answer is real structure, and merging across it
 * would move text in the log to a place the model did not produce it.
 */
function collapseDeltas(events: RunEvent[]): RunEvent[] {
  const rows: RunEvent[] = [];

  for (const event of events) {
    if (event.type !== "token_delta") {
      rows.push(event);
      continue;
    }
    const last = rows[rows.length - 1];
    if (last?.type === "token_delta" && last.nodeName === event.nodeName) {
      rows[rows.length - 1] = {
        ...last,
        delta: (last.delta ?? "") + (event.delta ?? ""),
      };
    } else {
      rows.push({ ...event });
    }
  }

  return rows;
}

/** Events that mark a failure, and are set in reverse. */
const FAILED = new Set(["node_error", "error"]);

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
  const rows = useMemo(() => collapseDeltas(events), [events]);

  // Follow the tail while a run is in flight. Only during a run, so reading
  // back through a finished log is not fought by an autoscroll. Keyed on the
  // event count rather than the row count so the view keeps following an
  // answer that is growing inside a single row.
  useEffect(() => {
    if (status === "running") {
      endRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [events.length, status]);

  if (status === "idle" && events.length === 0) {
    return (
      <div className="flex h-full min-h-[24rem] items-center justify-center px-8 py-16">
        <p className="max-w-[32ch] text-center font-mono text-[0.6875rem] uppercase leading-loose tracking-[0.2em] text-muted-ink">
          The run appears here
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <ol className="flex-1 overflow-y-auto">
        {rows.map((event, index) => {
          const failed = FAILED.has(event.type);
          return (
            <li
              key={index}
              className={cn(
                "flex gap-4 border-b border-hairline px-5 py-2.5 font-mono text-xs leading-relaxed",
                failed && "bg-ink text-paper",
              )}
            >
              <span
                className={cn(
                  "w-14 shrink-0 uppercase tracking-[0.15em]",
                  failed ? "text-paper/60" : "text-muted-ink",
                )}
              >
                {LABELS[event.type] ?? event.type}
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 break-words",
                  // A model's answer carries its own line breaks, and every
                  // other row is a single line that has none to lose.
                  event.type === "token_delta" && "whitespace-pre-wrap",
                )}
              >
                {describe(event)}
              </span>
              {event.duration !== undefined && (
                <span
                  className={cn(
                    "shrink-0 tabular-nums",
                    failed ? "text-paper/60" : "text-muted-ink",
                  )}
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
        <div className="border-t-2 border-ink bg-ink px-5 py-4 text-paper">
          <p className="font-mono text-[0.625rem] uppercase tracking-[0.2em] text-paper/60">
            {error.type}
          </p>
          <p className="mt-2 font-mono text-xs leading-relaxed break-words">
            {error.message}
          </p>
        </div>
      )}

      {result && (
        <div className="border-t-2 border-ink">
          <p className="border-b border-hairline px-5 py-3 font-mono text-[0.625rem] uppercase tracking-[0.2em] text-muted-ink">
            Final state
          </p>
          <pre className="max-h-64 overflow-auto px-5 py-4 font-mono text-xs leading-relaxed">
            <code>{JSON.stringify(result, null, 2)}</code>
          </pre>
        </div>
      )}
    </div>
  );
}
