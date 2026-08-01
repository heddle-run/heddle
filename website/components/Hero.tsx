import { Badge, Button, BoxedFrame, Chip } from "@/ds";
import Link from "next/link";
import InstallTabs from "./InstallTabs";
import Loom from "./Loom";
import { AGENT_SPEC_URL, GITHUB_URL, VERSION } from "@/lib/constants";

const marks = [
  { icon: "braces", label: "Nothing in your lockfile" },
  { icon: "shield", label: "OS-level sandbox" },
  { icon: "network", label: "CLI or HTTP server" },
  { icon: "scroll-text", label: "MIT licensed" },
];

/* The leading article is set plainly: only the content words take a hover hue,
   so "A" does not glow on its own. */
const HERO_WORDS = [
  { text: "batteries-included", hue: "var(--hue-purple)" },
  { text: "declarative", hue: "var(--hue-blue)" },
  { text: "agent", hue: "var(--hue-emerald)" },
  { text: "runtime.", hue: "var(--brand-pink)" },
];

export default function Hero() {
  return (
    <section style={{ position: "relative" }}>
      <div
        className="hd-container hd-container-narrow"
        style={{ paddingTop: "var(--space-20)", paddingBottom: "var(--space-16)" }}
      >
        <div style={{ display: "flex", justifyContent: "center" }}>
          <Badge pulse>v{VERSION} is live</Badge>
        </div>

        <h1
          className="ff-fade-in-up"
          style={{
            margin: "var(--space-8) 0 0",
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "center",
            gap: "0 .28em",
            fontSize: "clamp(34px,6vw,72px)",
            fontWeight: "var(--fw-medium)",
            letterSpacing: "var(--tracking-tighter)",
            lineHeight: "var(--lh-tight)",
            color: "var(--text-strong)",
            textAlign: "center",
            /* "batteries-included" is a single 18-character word; at the small
               end of the clamp it has to be allowed to break rather than push
               the line past a phone's viewport. */
            overflowWrap: "break-word",
          }}
        >
          <span>A</span>
          {HERO_WORDS.map((w) => (
            <span
              key={w.text}
              className="hd-hero-word"
              style={{ ["--hd-hue" as string]: w.hue }}
            >
              {w.text}
            </span>
          ))}
        </h1>

        <p
          className="ff-fade-in-up ff-delay-100"
          style={{
            margin: "var(--space-6) auto 0",
            maxWidth: "var(--container-prose)",
            textAlign: "center",
            fontSize: "var(--fs-lg)",
            lineHeight: "var(--lh-relaxed)",
            color: "var(--text-body)",
          }}
        >
          The tool-calling loop, the sandbox, the HTTP server, the guardrails
          and the retry policies are already in the runtime. None of them are in
          your codebase. Write the flow as an{" "}
          <a
            href={AGENT_SPEC_URL}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              color: "var(--brand-pink)",
              textDecoration: "underline",
              textUnderlineOffset: 3,
            }}
          >
            Open Agent Spec
          </a>{" "}
          document, and heddle is what you point at it.
        </p>

        <div
          className="ff-fade-in-up ff-delay-200"
          style={{
            marginTop: "var(--space-10)",
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "center",
            gap: "var(--space-4)",
          }}
        >
          <Link href="/docs">
            <Button size="lg" iconAfter="arrow-right">
              Read the docs
            </Button>
          </Link>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
            <Button size="lg" variant="outline" icon="github">
              View source
            </Button>
          </a>
        </div>

        <div className="ff-fade-in-up ff-delay-300">
          <InstallTabs />
        </div>

        <ul
          style={{
            listStyle: "none",
            margin: "var(--space-8) 0 0",
            padding: 0,
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "center",
            gap: "var(--space-3)",
          }}
        >
          {marks.map((m) => (
            <li key={m.label}>
              <Chip icon={m.icon}>{m.label}</Chip>
            </li>
          ))}
        </ul>
      </div>

      <div className="hd-container" style={{ paddingBottom: "var(--space-24)" }}>
        <BoxedFrame beam pad="var(--space-8)">
          <Loom />
        </BoxedFrame>
      </div>
    </section>
  );
}
