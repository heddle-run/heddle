import { WeaveTexture } from "@/components/WeaveTexture";
import { specimenSpread } from "@/lib/constants";

/* 002 — the position, on the always-dark navy band. The window shows the real
   researcher spec (specimenSpread), not an illustration. Backgrounds use the
   --surface-code aliases because --surface-inverse flips to white in the dark
   theme; the code surfaces are the ones that stay navy-dark in both. */
const SPEC_LINES = specimenSpread.spec.split("\n").slice(0, 14);

export default function Position() {
  return (
    <section
      id="position"
      style={{
        position: "relative",
        borderTop: "1px solid var(--border-hairline)",
        backgroundColor: "var(--surface-code)",
      }}
    >
      <WeaveTexture variant="strong" inverse />
      <div
        className="hds-container hds-position-grid"
        style={{
          position: "relative",
          zIndex: 1,
          paddingTop: "var(--section-y)",
          paddingBottom: "var(--section-y)",
        }}
      >
        <div>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              letterSpacing: "var(--ls-label)",
              textTransform: "uppercase",
              display: "flex",
              gap: 12,
            }}
          >
            <span style={{ color: "var(--slate-400)" }}>002</span>
            <span style={{ color: "var(--blurple-300)" }}>Position</span>
          </div>
          <h2
            style={{
              fontFamily: "var(--font-serif)",
              fontStyle: "italic",
              fontSize: "var(--fs-h1)",
              letterSpacing: "var(--ls-heading)",
              color: "var(--code-fg)",
              margin: "14px 0 0",
            }}
          >
            The specification is the program.
          </h2>
          <p
            style={{
              fontSize: "var(--fs-body-lg)",
              color: "var(--slate-300)",
              lineHeight: 1.6,
              margin: "14px 0 0",
            }}
          >
            Your agent is a document, not framework code. Batteries included
            usually means a bigger library in your lockfile; heddle refuses the
            trade, and the same equipment sits behind a binary you point at the
            document.
          </p>
          <p
            style={{
              fontSize: "var(--fs-body)",
              color: "var(--slate-400)",
              lineHeight: 1.62,
              margin: "14px 0 0",
            }}
          >
            And the document is an Open Agent Specification flow. Oracle
            publishes that format; this project did not invent it. So it runs on
            any other conforming runtime, which makes leaving cheap and staying
            a choice.
          </p>
        </div>

        <div
          style={{
            background: "var(--surface-code-alt)",
            border: "1px solid var(--border-inverse)",
            borderRadius: "var(--radius-card)",
            overflow: "hidden",
            fontFamily: "var(--font-mono)",
          }}
        >
          <div
            style={{
              padding: "9px 12px",
              borderBottom: "1px solid var(--border-inverse)",
              fontSize: 12,
              color: "var(--slate-400)",
            }}
          >
            flow.yaml
          </div>
          <pre
            style={{
              margin: 0,
              padding: "14px 16px",
              fontSize: 13.5,
              lineHeight: 1.6,
              color: "var(--code-fg)",
              overflowX: "auto",
            }}
          >
            {SPEC_LINES.join("\n")}
          </pre>
        </div>
      </div>
    </section>
  );
}
