import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { CodeBlock, SectionHeading } from "@/ds-heddle";
import LibraryTag from "@/components/LibraryTag";
import { GITHUB_URL } from "@/lib/constants";
import {
  bundleCommand,
  libraryEntries,
  libraryEntry,
  type LibraryEntry,
} from "@/lib/library";

interface Params {
  params: Promise<{ slug: string }>;
}

/* A static export needs the whole set up front, and the set is whatever
   directories library/ holds at build time. */
export function generateStaticParams() {
  return libraryEntries().map((entry) => ({ slug: entry.name }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const entry = libraryEntry(slug);
  if (!entry) return {};

  return {
    title: entry.title,
    description: entry.summary,
    alternates: { canonical: `/library/${entry.name}` },
    openGraph: {
      title: `${entry.title} — heddle library`,
      description: entry.summary,
      url: `https://heddle.run/library/${entry.name}`,
      siteName: "heddle",
      type: "article",
    },
  };
}

const label = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-label)",
  letterSpacing: "var(--ls-label)",
  textTransform: "uppercase",
  color: "var(--text-subtle)",
  margin: 0,
} as const;

function Facts({ entry }: { entry: LibraryEntry }) {
  const rows: Array<[string, string]> = [];

  if (entry.model) rows.push(["Model", entry.model]);
  rows.push(["Tools", entry.tools.length > 0 ? entry.tools.join(", ") : "none"]);
  rows.push([
    "Mounts",
    entry.mounts.length > 0 ? entry.mounts.join(", ") : "none",
  ]);
  if (entry.requires.env?.length) {
    rows.push(["Environment", entry.requires.env.join(", ")]);
  }
  if (entry.requires.binaries?.length) {
    rows.push(["On PATH", entry.requires.binaries.join(", ")]);
  }

  return (
    <dl
      style={{
        display: "grid",
        gap: 0,
        margin: 0,
        border: "1px solid var(--border-hairline)",
        borderRadius: "var(--radius-card)",
        overflow: "hidden",
      }}
    >
      {rows.map(([term, value], index) => (
        <div
          key={term}
          style={{
            display: "flex",
            gap: 16,
            justifyContent: "space-between",
            padding: "11px 14px",
            borderTop:
              index === 0 ? undefined : "1px solid var(--border-hairline)",
          }}
        >
          <dt style={label}>{term}</dt>
          <dd
            style={{
              margin: 0,
              fontFamily: "var(--font-mono)",
              fontSize: 12.5,
              color: "var(--text-body)",
              textAlign: "right",
              wordBreak: "break-word",
            }}
          >
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export default async function LibraryEntryPage({ params }: Params) {
  const { slug } = await params;
  const entry = libraryEntry(slug);
  if (!entry) notFound();

  const source = `${GITHUB_URL}/tree/main/library/${entry.name}`;
  const runInput = JSON.stringify(entry.input);

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
            style={{ paddingTop: 56, paddingBottom: 48 }}
          >
            <Link
              href="/library"
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                color: "var(--text-muted)",
                textDecoration: "none",
              }}
            >
              ← Library
            </Link>

            <div style={{ marginTop: 24, maxWidth: "62ch" }}>
              <SectionHeading eyebrow={entry.name} title={entry.title} />
              <p
                style={{
                  marginTop: 20,
                  fontSize: "var(--fs-body-lg)",
                  lineHeight: 1.7,
                  color: "var(--text-muted)",
                }}
              >
                {entry.blurb}
              </p>
              <div
                style={{
                  display: "flex",
                  gap: 6,
                  flexWrap: "wrap",
                  marginTop: 20,
                }}
              >
                {entry.tags.map((tag) => (
                  <LibraryTag key={tag}>{tag}</LibraryTag>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section style={{ borderTop: "1px solid var(--border-hairline)" }}>
          <div
            className="hds-container"
            style={{ paddingTop: 48, paddingBottom: 48 }}
          >
            <div className="hds-library-detail">
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1fr)",
                  gap: 32,
                }}
              >
                <div>
                  <h2 style={{ ...label, marginBottom: 14 }}>Run it</h2>
                  <CodeBlock
                    filename="terminal"
                    code={`node library/build.mjs ${entry.name}
heddle run library/dist/${entry.name}.heddle`}
                  />
                  <p
                    style={{
                      marginTop: 14,
                      fontSize: 14,
                      lineHeight: 1.7,
                      color: "var(--text-muted)",
                    }}
                  >
                    The bundle records a default input, so that second command
                    needs no flags. To pass your own:
                  </p>
                  <CodeBlock
                    filename="terminal"
                    style={{ marginTop: 12 }}
                    code={`heddle run library/dist/${entry.name}.heddle \\\n  --input '${runInput}'`}
                  />
                </div>

                <div>
                  <h2 style={{ ...label, marginBottom: 14 }}>
                    What build.mjs runs
                  </h2>
                  <CodeBlock filename="terminal" code={bundleCommand(entry)} />
                </div>

                <div>
                  <h2 style={{ ...label, marginBottom: 14 }}>The flow</h2>
                  <div style={{ maxHeight: 560, overflow: "auto" }}>
                    <CodeBlock filename={entry.flow} code={entry.spec} />
                  </div>
                </div>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1fr)",
                  gap: 24,
                }}
              >
                <div>
                  <h2 style={{ ...label, marginBottom: 14 }}>Facts</h2>
                  <Facts entry={entry} />
                </div>

                <div>
                  <h2 style={{ ...label, marginBottom: 14 }}>The entry</h2>
                  <ul
                    style={{
                      listStyle: "none",
                      margin: 0,
                      padding: 0,
                      display: "grid",
                      gap: 5,
                      fontFamily: "var(--font-mono)",
                      fontSize: 12.5,
                      color: "var(--text-body)",
                    }}
                  >
                    {entry.files.map((file) => (
                      <li key={file}>{file}</li>
                    ))}
                  </ul>
                  <p
                    style={{
                      marginTop: 14,
                      fontSize: 13,
                      lineHeight: 1.65,
                      color: "var(--text-subtle)",
                    }}
                  >
                    The spec, the tools and the mounted files travel in the
                    archive; the README and bundle.json stay here. Neither
                    carries the API key — a spec names it as an environment
                    variable and it resolves where the bundle runs.
                  </p>
                </div>

                <div>
                  <h2 style={{ ...label, marginBottom: 14 }}>Source</h2>
                  <a
                    href={source}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      fontSize: 14,
                      color: "var(--text-accent)",
                      textDecoration: "none",
                    }}
                  >
                    library/{entry.name} on GitHub →
                  </a>
                  <p
                    style={{
                      marginTop: 8,
                      fontSize: 13,
                      lineHeight: 1.65,
                      color: "var(--text-subtle)",
                    }}
                  >
                    Its README covers pointing this at your own data, and what
                    it will not do.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
