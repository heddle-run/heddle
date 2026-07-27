import type { Metadata } from "next";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import SectionLabel from "@/components/SectionLabel";
import CodeBlock from "@/components/CodeBlock";
import Playground from "@/components/playground/Playground";
import { Icon } from "@/ds";

export const metadata: Metadata = {
  title: "Playground",
  description:
    "Write an Agent Spec flow, wire tools and plugins, and run it in the browser against a live heddle engine.",
};

export default function PlaygroundPage() {
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      <Nav />

      <main id="main">
        <section
          className="hd-section"
          style={{ paddingBottom: "var(--space-10)" }}
        >
          <div className="hd-container">
            <SectionLabel index="007">Playground</SectionLabel>

            <h1
              style={{
                margin: 0,
                maxWidth: "16ch",
                fontSize: "clamp(36px,6vw,72px)",
                fontWeight: "var(--fw-medium)",
                letterSpacing: "var(--tracking-tighter)",
                lineHeight: "var(--lh-tight)",
                color: "var(--text-strong)",
              }}
            >
              Run it here.
            </h1>

            <p
              style={{
                margin: "var(--space-6) 0 0",
                maxWidth: "54ch",
                fontSize: "var(--fs-lg)",
                lineHeight: "var(--lh-relaxed)",
                color: "var(--text-body)",
              }}
            >
              A flow, its inputs, the tools it calls and the plugins that extend
              it — all editable, all executed by the same engine the CLI drives.
              Events stream back as the run happens.
            </p>

            {/* Security note. Kept prominent: it is the one thing on this page a
                visitor must read before pasting a key. */}
            <div
              style={{
                display: "flex",
                gap: "var(--space-3)",
                margin: "var(--space-8) 0 0",
                maxWidth: "62ch",
                padding: "var(--space-4)",
                border: "1px solid var(--brand-pink-20)",
                background: "var(--brand-pink-05)",
                borderRadius: "var(--radius-lg)",
              }}
            >
              <span
                aria-hidden
                style={{
                  color: "var(--brand-pink)",
                  display: "inline-flex",
                  flex: "0 0 auto",
                  marginTop: 2,
                }}
              >
                <Icon name="shield" size={16} />
              </span>
              <p
                style={{
                  margin: 0,
                  fontSize: "var(--fs-sm)",
                  lineHeight: "var(--lh-relaxed)",
                  color: "var(--text-body)",
                }}
              >
                Tools and plugins you submit run in their own sandboxed
                processes and are deleted when the run ends. Nothing is stored.
                An API key in your flow does travel to the engine to reach the
                model — use a key you are willing to spend, and revoke it when
                you are done.
              </p>
            </div>
          </div>
        </section>

        <Playground />

        <section className="hd-section">
          <div className="hd-container">
            <SectionLabel index="008">The same thing, locally</SectionLabel>

            <h2
              style={{
                margin: 0,
                maxWidth: "24ch",
                fontSize: "clamp(30px,4vw,48px)",
                fontWeight: "var(--fw-semibold)",
                letterSpacing: "var(--tracking-tight)",
                lineHeight: "var(--lh-snug)",
                color: "var(--text-strong)",
              }}
            >
              Nothing here is browser-only.
            </h2>

            <p
              style={{
                margin: "var(--space-6) 0 0",
                maxWidth: "58ch",
                fontSize: "var(--fs-lg)",
                lineHeight: "var(--lh-relaxed)",
                color: "var(--text-body)",
              }}
            >
              The playground has no privileges the CLI lacks. Save the flow to a
              file, put the tools in a directory, and the same run happens on
              your own machine — with your own keys, and without the limits this
              page runs under.
            </p>

            <div style={{ marginTop: "var(--space-8)", maxWidth: 720 }}>
              <CodeBlock
                label="terminal"
                code={`brew install spichen/tap/heddle
heddle run flow.yaml --tools-dir ./tools --input '{"text":"hello"}'`}
              />
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </>
  );
}
