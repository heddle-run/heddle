"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import { gsap } from "gsap";
import { TextPlugin } from "gsap/TextPlugin";
import { useReducedMotion } from "motion/react";

gsap.registerPlugin(TextPlugin);

type Line = { text: string; kind?: "prompt" | "tool" | "ok" | "dim" };

const COLOR: Partial<Record<string, string>> = {
  prompt: "var(--code-fg)",
  tool: "var(--blurple-300)",
  ok: "var(--cyan-300)",
  dim: "var(--slate-400)",
};

/* The hero's run log is the one place on the page that is literally a
   terminal executing — typing the command, then streaming the tool calls
   and result, dramatizes "point heddle at a document and it runs" rather
   than decorating a static screenshot of it. Every other line just fades in
   as a block; only the `$ heddle run ...` prompt is typed character by
   character, the way it would be at an actual shell. Reduced motion shows
   the whole log settled, instantly. */
export function AnimatedTerminal({
  lines,
  title = "zsh",
  style,
}: {
  lines: Line[];
  title?: string;
  style?: CSSProperties;
}) {
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (reduce) return;
    const rows = rowRefs.current.filter((r): r is HTMLDivElement => !!r);
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ defaults: { ease: "none" } });
      rows.forEach((row, i) => {
        const line = lines[i];
        const target = row.querySelector<HTMLSpanElement>("[data-line-text]");
        const cursor = row.querySelector<HTMLSpanElement>("[data-cursor]");
        if (!target) return;
        if (line.kind === "prompt") {
          tl.to(target, {
            duration: Math.min(Math.max(line.text.length * 0.016, 0.2), 0.8),
            text: { value: line.text },
          });
          if (cursor) {
            tl.set(cursor, { autoAlpha: 0 }, "<");
          }
        } else {
          tl.set(target, { text: line.text }, "+=0.06");
          tl.fromTo(
            row,
            { autoAlpha: 0, y: 4 },
            { autoAlpha: 1, y: 0, duration: 0.18 },
            "<",
          );
        }
      });
    });
    return () => ctx.revert();
  }, [reduce, lines]);

  return (
    <div
      style={{
        background: "var(--surface-code)",
        borderRadius: "var(--radius-card)",
        border: "1px solid var(--border-inverse)",
        overflow: "hidden",
        fontFamily: "var(--font-mono)",
        ...style,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "9px 12px",
          borderBottom: "1px solid var(--border-inverse)",
        }}
      >
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{
              width: 9,
              height: 9,
              borderRadius: "50%",
              background: "#2b5479",
            }}
          />
        ))}
        <span
          style={{ fontSize: 11.5, color: "var(--slate-400)", marginLeft: 8 }}
        >
          {title}
        </span>
      </div>
      <div
        style={{ padding: "14px 16px", fontSize: "var(--fs-code)", lineHeight: 1.75 }}
      >
        {lines.map((line, i) => (
          <div
            key={i}
            ref={(el) => {
              rowRefs.current[i] = el;
            }}
            style={{
              color: COLOR[line.kind ?? ""] ?? "var(--slate-200)",
              whiteSpace: "pre-wrap",
              opacity: reduce || line.kind === "prompt" ? 1 : 0,
            }}
          >
            {line.kind === "prompt" && (
              <span style={{ color: "var(--blurple-400)" }}>$ </span>
            )}
            <span data-line-text>{reduce ? line.text : ""}</span>
            {line.kind === "prompt" && (
              <span data-cursor className="hds-cursor" aria-hidden="true" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
