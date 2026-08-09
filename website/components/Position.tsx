import { AGENT_SPEC_URL, specimenSpread } from "@/lib/constants";

/* 002 — how it works, on the page's first dark moment. The section paints no
   navy band of its own: the loom world behind the page goes navy for this
   chapter (weave-world/chapters.ts, keyframe 2 — the "first shed"), and the
   Chapter wrapper's band scrim settles the copy on it. Text colours still use
   the --code/slate aliases that read on navy in both themes.

   The window shows the whole specimen — a real library flow with its English
   instruction in full view. For this page's reader, the file being readable
   IS the argument, so the sample must never elide the instruction. */
const SPEC_LINES = specimenSpread.spec.split("\n");

export default function Position() {
  return (
    <div style={{ position: "relative" }}>
      <div
        className="hds-container hds-position-grid"
        style={{
          position: "relative",
          zIndex: 1,
          paddingTop: "var(--section-y-sm)",
          paddingBottom: "var(--section-y-sm)",
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
            <span style={{ color: "var(--blurple-300)" }}>How it works</span>
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
            The whole thing is one file you can read.
          </h2>
          <p
            style={{
              fontSize: "var(--fs-body-lg)",
              color: "var(--slate-300)",
              lineHeight: 1.6,
              margin: "14px 0 0",
            }}
          >
            A heddle flow is a text file that names the steps, the instructions
            and the tools — the same species of file as a docker-compose file,
            a GitHub Actions workflow or a Home Assistant automation. If you
            have edited one of those, you can edit this. Open it, change a
            line, run it again.
          </p>
          <p
            style={{
              fontSize: "var(--fs-body)",
              color: "var(--slate-400)",
              lineHeight: 1.62,
              margin: "14px 0 0",
            }}
          >
            The format is not ours. It is the{" "}
            <a
              href={AGENT_SPEC_URL}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: "var(--cyan-500)",
                textDecoration: "underline",
                textUnderlineOffset: 3,
              }}
            >
              Open Agent Specification
            </a>
            , published by Oracle, and other runtimes read it too. If heddle
            disappeared tomorrow, your files would still work somewhere else.
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
    </div>
  );
}
