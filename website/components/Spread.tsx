import { WindowChrome, Icon } from "@/ds";
import SectionLabel from "./SectionLabel";
import { specimenSpread } from "@/lib/constants";

const lineTone: Record<string, string> = {
  prompt: "var(--text-strong)",
  cont: "var(--text-body)",
  muted: "var(--text-faint)",
  step: "var(--text-strong)",
  tool: "var(--brand-pink)",
  out: "var(--text-body)",
  blank: "transparent",
};

export default function Spread() {
  return (
    <section className="hd-section">
      <div className="hd-container">
        <SectionLabel index="005">In practice</SectionLabel>

        <h2
          style={{
            margin: "0 0 var(--space-12)",
            maxWidth: "24ch",
            fontSize: "clamp(30px,4vw,48px)",
            fontWeight: "var(--fw-semibold)",
            letterSpacing: "var(--tracking-tight)",
            lineHeight: "var(--lh-snug)",
            color: "var(--text-strong)",
          }}
        >
          The document on the left. The run on the right.
        </h2>

        <div className="hd-split" style={{ alignItems: "stretch" }}>
          <WindowChrome beam={false}>
            <Caption glyph="file-code">flow.yaml</Caption>
            <pre
              style={{
                margin: 0,
                padding: "var(--space-5)",
                maxHeight: 520,
                overflow: "auto",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--fs-xs)",
                lineHeight: 1.65,
                color: "var(--text-body)",
              }}
            >
              <code>{specimenSpread.spec}</code>
            </pre>
          </WindowChrome>

          <WindowChrome>
            <Caption glyph="terminal">heddle run</Caption>
            <div
              style={{
                padding: "var(--space-5)",
                maxHeight: 520,
                overflow: "auto",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--fs-xs)",
                lineHeight: 1.75,
              }}
            >
              {specimenSpread.terminal.map((line, i) => (
                <div
                  key={i}
                  style={{
                    color: lineTone[line.kind] ?? "var(--text-body)",
                    minHeight: "1.75em",
                    whiteSpace: "pre",
                  }}
                >
                  {line.kind === "prompt" ? `$ ${line.text}` : line.text}
                </div>
              ))}
            </div>
          </WindowChrome>
        </div>
      </div>
    </section>
  );
}

function Caption({ glyph, children }: { glyph: string; children: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        padding: "var(--space-2) var(--space-5)",
        borderBottom: "1px solid var(--border-hairline)",
        background: "var(--surface-subtle)",
      }}
    >
      <span
        aria-hidden
        style={{ display: "inline-flex", color: "var(--brand-pink)" }}
      >
        <Icon name={glyph} size={12} />
      </span>
      <span className="hd-eyebrow">{children}</span>
    </div>
  );
}
