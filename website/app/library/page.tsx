import type { Metadata } from "next";
import Link from "next/link";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { CodeBlock, SectionHeading } from "@/ds-heddle";
import LibraryTag from "@/components/LibraryTag";
import { GITHUB_URL } from "@/lib/constants";
import { libraryEntries, requirementNames } from "@/lib/library";

export const metadata: Metadata = {
  title: "Library",
  description:
    "Ready-made heddle agent bundles. Each one packs into a single .heddle file — flow, tools and data — that runs anywhere heddle is installed.",
  alternates: { canonical: "/library" },
  openGraph: {
    title: "heddle library — ready-made agent bundles",
    description:
      "A local meeting notetaker and a Codex-style coding agent. Each one a single file that runs anywhere heddle is installed.",
    url: "https://heddle.run/library",
    siteName: "heddle",
    type: "website",
  },
};

const LIBRARY_URL = `${GITHUB_URL}/tree/main/library`;

/* Named by heddle's own labeller, so the card promises what `heddle doctor`
   checks — see the note on `requires` in lib/library.ts. */
function Requirement({ entry }: { entry: ReturnType<typeof libraryEntries>[0] }) {
  const needs = requirementNames(entry);
  if (needs.length === 0) return null;
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 11.5,
        color: "var(--text-subtle)",
      }}
    >
      {needs.join(" · ")}
    </span>
  );
}

export default function LibraryPage() {
  const entries = libraryEntries();

  return (
    <div className="hds" style={{ minHeight: "100vh" }}>
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      <Nav />

      <main id="main">
        <section>
          <div
            className="hds-container"
            style={{ paddingTop: 72, paddingBottom: "var(--section-y)" }}
          >
            <SectionHeading
              eyebrow="Library"
              title="Agents worth keeping."
              lede="Each entry is a whole agent — the flow, the tools it calls, the files it reads — packed into one .heddle file that runs anywhere heddle is installed. No account, no registry, no install step for the agent itself."
            />

            {entries.length === 0 ? (
              <p
                style={{
                  marginTop: 36,
                  fontSize: 15,
                  color: "var(--text-muted)",
                }}
              >
                No entries were found in this build.{" "}
                <a href={LIBRARY_URL} style={{ color: "var(--text-accent)" }}>
                  Browse them on GitHub
                </a>
                .
              </p>
            ) : (
              <div className="hds-library-grid">
                {entries.map((entry) => (
                  <Link
                    key={entry.name}
                    href={`/library/${entry.name}`}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 12,
                      padding: 20,
                      background: "var(--surface-card)",
                      border: "1px solid var(--border-hairline)",
                      borderRadius: "var(--radius-card)",
                      boxShadow: "var(--shadow-xs)",
                      textDecoration: "none",
                      height: "100%",
                    }}
                  >
                    <div
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "var(--fs-label)",
                        letterSpacing: "var(--ls-label)",
                        textTransform: "uppercase",
                        color: "var(--text-accent)",
                      }}
                    >
                      {entry.name}
                    </div>

                    <div
                      style={{
                        fontSize: "var(--fs-h4)",
                        fontWeight: "var(--fw-medium)",
                        letterSpacing: "var(--ls-heading)",
                        color: "var(--text-strong)",
                      }}
                    >
                      {entry.title}
                    </div>

                    <p
                      style={{
                        margin: 0,
                        fontSize: 14,
                        lineHeight: 1.6,
                        color: "var(--text-body)",
                        flex: 1,
                      }}
                    >
                      {entry.summary}
                    </p>

                    <div
                      style={{ display: "flex", gap: 6, flexWrap: "wrap" }}
                    >
                      {entry.tags.map((tag) => (
                        <LibraryTag key={tag}>{tag}</LibraryTag>
                      ))}
                    </div>

                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 12,
                        alignItems: "baseline",
                        paddingTop: 12,
                        borderTop: "1px solid var(--border-hairline)",
                      }}
                    >
                      <span
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: 11.5,
                          color: "var(--text-subtle)",
                        }}
                      >
                        {entry.tools.length > 0
                          ? `${entry.tools.length} tool${entry.tools.length === 1 ? "" : "s"}`
                          : "no tools"}
                      </span>
                      <Requirement entry={entry} />
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </section>

        <section style={{ borderTop: "1px solid var(--border-hairline)" }}>
          <div
            className="hds-container"
            style={{
              paddingTop: "var(--section-y)",
              paddingBottom: "var(--section-y)",
            }}
          >
            <SectionHeading
              eyebrow="Using one"
              title="One command."
              lede="Every entry is packed and published at its own address — a single archive carrying the flow, its tools and whatever data it reads. npx fetches heddle, the bare name fetches the agent, and nothing is installed."
            />

            <div style={{ marginTop: 32, maxWidth: 760 }}>
              <CodeBlock
                filename="terminal"
                code={`npx @heddle-run/cli run coding-agent`}
              />
            </div>

            <p
              style={{
                marginTop: 24,
                maxWidth: "62ch",
                fontSize: 15,
                lineHeight: 1.7,
                color: "var(--text-muted)",
              }}
            >
              What a bundle deliberately does not carry is credentials: a spec
              names its key as <code>$OPENAI_API_KEY</code> and it resolves on
              the machine that runs, never the one that packed. Sandbox policy
              is the same — a file that arrived in the mail does not get to
              decide what it may read, so <code>--safe</code> is yours to pass.{" "}
              <Link href="/docs/bundles" style={{ color: "var(--text-accent)" }}>
                How bundles work
              </Link>
              .
            </p>
          </div>
        </section>

        <section style={{ borderTop: "1px solid var(--border-hairline)" }}>
          <div
            className="hds-container"
            style={{
              paddingTop: "var(--section-y)",
              paddingBottom: "var(--section-y)",
            }}
          >
            <SectionHeading
              eyebrow="Adding one"
              title="An entry is a directory."
              lede="A flow, a bundle.json saying what it is and how to pack it, a README, and the tools and files it needs. CI packs every entry on every change, so a listing here is a bundle that builds."
            />
            <p style={{ marginTop: 28 }}>
              <a
                href={LIBRARY_URL}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  fontSize: 15,
                  color: "var(--text-accent)",
                  textDecoration: "none",
                }}
              >
                library/ on GitHub →
              </a>
            </p>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
