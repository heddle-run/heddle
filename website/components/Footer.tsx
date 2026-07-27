import Link from "next/link";
import { BoxedFrame } from "@/ds";
import Wordmark from "./Wordmark";
import { AGENT_SPEC_URL, GITHUB_URL, NPM_URL, VERSION } from "@/lib/constants";

const columns = [
  {
    title: "Project",
    links: [
      { label: "Documentation", href: "/docs" },
      { label: "Getting started", href: "/docs/getting-started" },
      { label: "CLI reference", href: "/docs/cli-reference" },
      { label: "Playground", href: "/playground" },
    ],
  },
  {
    title: "Source",
    links: [
      { label: "GitHub", href: GITHUB_URL, external: true },
      { label: "npm", href: NPM_URL, external: true },
      {
        label: "Examples",
        href: `${GITHUB_URL}/tree/main/examples`,
        external: true,
      },
    ],
  },
  {
    title: "Standard",
    links: [
      { label: "Open Agent Spec", href: AGENT_SPEC_URL, external: true },
      {
        label: "MIT licence",
        href: `${GITHUB_URL}/blob/main/LICENSE`,
        external: true,
      },
    ],
  },
];

const linkStyle = {
  fontSize: "var(--fs-sm)",
  color: "var(--text-muted)",
} as const;

export default function Footer() {
  return (
    <footer
      style={{
        borderTop: "1px solid var(--border-hairline)",
        background: "var(--bg-elevated)",
        padding: "var(--space-16) 0 var(--space-8)",
      }}
    >
      <div className="hd-container">
        <BoxedFrame
          corners="diagonal"
          edges="none"
          pad="var(--space-8)"
          style={{ marginBottom: "var(--space-8)" }}
        >
          <div className="hd-footer-grid">
            <div>
              <Wordmark size="lg" />
              <p
                style={{
                  margin: "var(--space-4) 0 0",
                  maxWidth: "34ch",
                  fontSize: "var(--fs-sm)",
                  lineHeight: "var(--lh-relaxed)",
                  color: "var(--text-muted)",
                }}
              >
                A CLI runtime for the Open Agent Specification. Open source, MIT
                licensed, and entirely local.
              </p>
              <p
                className="hd-mono"
                style={{
                  margin: "var(--space-4) 0 0",
                  color: "var(--text-faint)",
                }}
              >
                v{VERSION}
              </p>
            </div>

            {columns.map((column) => (
              <nav key={column.title} aria-label={column.title}>
                <h2 className="hd-eyebrow" style={{ display: "block" }}>
                  {column.title}
                </h2>
                <ul
                  style={{
                    listStyle: "none",
                    margin: "var(--space-4) 0 0",
                    padding: 0,
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--space-2)",
                  }}
                >
                  {column.links.map((link) => (
                    <li key={link.label}>
                      {"external" in link && link.external ? (
                        <a
                          href={link.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ff-text-transition"
                          style={linkStyle}
                        >
                          {link.label}
                        </a>
                      ) : (
                        <Link
                          href={link.href}
                          className="ff-text-transition"
                          style={linkStyle}
                        >
                          {link.label}
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </nav>
            ))}
          </div>
        </BoxedFrame>

        <div
          className="hd-footer-bottom"
          style={{
            borderTop: "1px solid var(--border-hairline)",
            paddingTop: "var(--space-8)",
            fontSize: "var(--fs-xs)",
            color: "var(--text-muted)",
          }}
        >
          <p style={{ margin: 0 }}>MIT licensed</p>
          <p style={{ margin: 0 }}>
            Built by{" "}
            <a
              href="https://github.com/spichen"
              target="_blank"
              rel="noopener noreferrer"
              className="ff-text-transition"
              style={{ color: "var(--text-strong)" }}
            >
              spichen
            </a>
          </p>
        </div>
      </div>
    </footer>
  );
}
