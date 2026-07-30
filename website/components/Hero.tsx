import { Badge, Button, BoxedFrame, Chip } from "@/ds";
import Link from "next/link";
import CopyCommand from "./CopyCommand";
import Loom from "./Loom";
import {
  AGENT_SPEC_URL,
  GITHUB_URL,
  VERSION,
  installCommands,
} from "@/lib/constants";

const marks = [
  { icon: "braces", label: "No SDK required" },
  { icon: "shield", label: "Agent Spec compliant" },
  { icon: "network", label: "CLI or HTTP server" },
  { icon: "scroll-text", label: "MIT licensed" },
];

const HERO_WORDS = [
  { text: "Weave", hue: "var(--hue-purple)" },
  { text: "agents", hue: "var(--hue-blue)" },
  { text: "from", hue: "var(--hue-emerald)" },
  { text: "spec.", hue: "var(--brand-pink)" },
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
            fontSize: "clamp(48px,8vw,96px)",
            fontWeight: "var(--fw-medium)",
            letterSpacing: "var(--tracking-tighter)",
            lineHeight: "var(--lh-tight)",
            color: "var(--text-strong)",
            textAlign: "center",
          }}
        >
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
          heddle compiles a declarative{" "}
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
            Agent Spec
          </a>{" "}
          into an executable graph — tool-calling loop, branching and
          any-language tools already in the box. There is no SDK to install and
          nothing to subclass: the flow is a document, not code. Run it from the
          CLI, or serve it over HTTP.
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

        <div
          className="ff-fade-in-up ff-delay-300"
          style={{
            margin: "var(--space-12) auto 0",
            maxWidth: 560,
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-3)",
          }}
        >
          {installCommands.map((c) => (
            <CopyCommand key={c.label} label={c.label} command={c.cmd} />
          ))}
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
