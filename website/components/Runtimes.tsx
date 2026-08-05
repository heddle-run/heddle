import { SectionHeading } from "@/ds-heddle";
import { Reveal } from "@/components/motion/Reveal";
import { runtimes } from "@/lib/constants";

/* Renders one line of a terminal transcript: a `$ ` prompt marker in
   blurple ahead of the command, everything else (continuations, blank
   lines, JSON output) in the code foreground. Same convention as the
   Hero and Position windows. */
function line(text: string, i: number) {
  const prompt = text.match(/^(\$ )(.*)$/);
  return (
    <div key={i} style={{ whiteSpace: "pre-wrap" }}>
      {prompt ? (
        <>
          <span style={{ color: "var(--blurple-400)" }}>{prompt[1]}</span>
          <span style={{ color: "var(--code-fg)" }}>{prompt[2]}</span>
        </>
      ) : (
        <span style={{ color: "var(--code-fg)" }}>{text}</span>
      )}
    </div>
  );
}

function RuntimeWindow({
  entry,
  index,
}: {
  entry: (typeof runtimes)["cli"];
  index: number;
}) {
  return (
    <Reveal index={index}>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          letterSpacing: "var(--ls-label)",
          textTransform: "uppercase",
          color: "var(--text-accent)",
          marginBottom: 10,
        }}
      >
        {entry.label}
      </div>
      <div
        style={{
          background: "var(--surface-code)",
          border: "1px solid var(--border-inverse)",
          borderRadius: "var(--radius-card)",
          overflow: "hidden",
          fontFamily: "var(--font-mono)",
          boxShadow: "var(--shadow-sm)",
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
          {entry.windowTitle}
        </div>
        <div
          style={{
            padding: "14px 16px",
            fontSize: "var(--fs-code)",
            lineHeight: 1.7,
            overflowX: "auto",
          }}
        >
          {entry.code.split("\n").map((text, i) => line(text, i))}
        </div>
      </div>
      <p
        style={{
          fontSize: 13.5,
          color: "var(--text-muted)",
          lineHeight: 1.6,
          margin: "10px 0 0",
        }}
      >
        {entry.caption}
      </p>
    </Reveal>
  );
}

/* 004 — the receipt for Position's "same equipment behind a binary" and
   Method's Point/Serve moves: the identical flow, run locally and served
   over HTTP, side by side. Both transcripts are checked against
   docs/cli-reference.mdx and docs/server.mdx rather than written to look
   plausible. */
export default function Runtimes() {
  return (
    <section id="runtimes" style={{ borderTop: "1px solid var(--border-hairline)" }}>
      <div
        className="hds-container"
        style={{
          paddingTop: "var(--section-y)",
          paddingBottom: "var(--section-y)",
        }}
      >
        <SectionHeading
          number="004"
          eyebrow="Runtimes"
          title="One document, two runtimes."
          lede="heddle run on your machine and heddle-server over HTTP are the same engine reading the same file. Moving from a laptop to a service is a deployment, not a rewrite."
        />
        <div className="hds-runtimes-grid" style={{ marginTop: 36 }}>
          <RuntimeWindow entry={runtimes.cli} index={0} />
          <RuntimeWindow entry={runtimes.server} index={1} />
        </div>
      </div>
    </section>
  );
}
