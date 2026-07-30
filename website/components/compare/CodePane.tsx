"use client";

import type { CompareFile } from "@/lib/compare";

/* The one piece of colour a line gets: a comment is dimmed and everything
   else is body text. Full syntax highlighting would need a tokeniser per
   language and would fight the monochrome palette for no reading benefit. */
const COMMENT: Record<string, string> = {
  yaml: "#",
  python: "#",
  bash: "#",
  javascript: "//",
  typescript: "//",
};

function commentAt(line: string, marker: string): number {
  const index = line.indexOf(marker);
  if (index === -1) return -1;

  // Only a marker with nothing but whitespace before it is certainly a
  // comment. Anything else may sit inside a string, and guessing wrong
  // greys out running code.
  return line.slice(0, index).trim() === "" ? index : -1;
}

function Line({ text, marker }: { text: string; marker?: string }) {
  const split = marker ? commentAt(text, marker) : -1;

  if (split === -1) return <>{text || " "}</>;

  return (
    <>
      {text.slice(0, split)}
      <span style={{ color: "var(--text-faint)" }}>{text.slice(split)}</span>
    </>
  );
}

export default function CodePane({ file }: { file: CompareFile }) {
  const lines = file.source.replace(/\n$/, "").split("\n");
  const marker = COMMENT[file.language];
  const gutter = String(lines.length).length;

  return (
    <pre
      style={{
        display: "flex",
        gap: "var(--space-4)",
        margin: 0,
        padding: "var(--space-4) var(--space-5)",
        minHeight: "100%",
        background: "var(--bg-inset)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--fs-xs)",
        lineHeight: "var(--lh-relaxed)",
        color: "var(--text-body)",
      }}
    >
      <span
        aria-hidden
        style={{
          flex: "0 0 auto",
          textAlign: "right",
          color: "var(--text-faint)",
          fontVariantNumeric: "tabular-nums",
          userSelect: "none",
        }}
      >
        {lines.map((_, index) => (
          <span key={index} style={{ display: "block" }}>
            {String(index + 1).padStart(gutter, " ")}
          </span>
        ))}
      </span>

      <code style={{ minWidth: 0, flex: 1 }}>
        {lines.map((line, index) => (
          <span key={index} style={{ display: "block" }}>
            <Line text={line} marker={marker} />
          </span>
        ))}
      </code>
    </pre>
  );
}
