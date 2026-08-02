import Link from "next/link";
import {
  AGENT_SPEC_URL,
  COMPARE_URL,
  GITHUB_URL,
  NPM_URL,
  PLAYGROUND_URL,
  VERSION,
} from "@/lib/constants";

const columns = [
  {
    title: "Project",
    links: [
      { label: "Documentation", href: "/docs" },
      { label: "Getting started", href: "/docs/getting-started" },
      { label: "Library", href: "/library" },
      { label: "CLI reference", href: "/docs/cli-reference" },
      { label: "Playground", href: PLAYGROUND_URL },
      /* The comparison is a view of the playground now; this is the link
         that opens on it. */
      { label: "Compare frameworks", href: COMPARE_URL },
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
  fontSize: 13.5,
  color: "var(--text-muted)",
  textDecoration: "none",
} as const;

export default function Footer() {
  return (
    <footer style={{ borderTop: "1px solid var(--border-hairline)" }}>
      <div
        className="hds-container hds-footer-grid"
        style={{ paddingTop: 48, paddingBottom: 48 }}
      >
        <div className="hds-footer-brand">
          <div
            style={{
              fontWeight: "var(--fw-medium)",
              fontSize: 16,
              color: "var(--text-strong)",
            }}
          >
            heddle
          </div>
          <p
            style={{
              fontSize: 13,
              color: "var(--text-muted)",
              lineHeight: 1.62,
              margin: "8px 0 0",
              maxWidth: "32ch",
            }}
          >
            A batteries-included declarative agent runtime. Open source and
            entirely local.
          </p>
        </div>

        {columns.map((column) => (
          <nav key={column.title} aria-label={column.title}>
            <h2
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                fontWeight: "var(--fw-regular)",
                letterSpacing: "var(--ls-label)",
                textTransform: "uppercase",
                color: "var(--text-subtle)",
                margin: 0,
              }}
            >
              {column.title}
            </h2>
            <ul
              style={{
                listStyle: "none",
                margin: "12px 0 0",
                padding: 0,
                display: "grid",
                gap: 7,
              }}
            >
              {column.links.map((link) => (
                <li key={link.label}>
                  {link.href.startsWith("http") ? (
                    <a
                      href={link.href}
                      /* Another origin, but still this project: the playground
                         opens in place, GitHub and npm do not. */
                      {...("external" in link && link.external
                        ? { target: "_blank", rel: "noopener noreferrer" }
                        : {})}
                      style={linkStyle}
                    >
                      {link.label}
                    </a>
                  ) : (
                    <Link href={link.href} style={linkStyle}>
                      {link.label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>

      <div style={{ borderTop: "1px solid var(--border-hairline)" }}>
        <div
          className="hds-container"
          style={{
            paddingTop: 16,
            paddingBottom: 16,
            fontFamily: "var(--font-mono)",
            fontSize: 11.5,
            color: "var(--text-subtle)",
            display: "flex",
            justifyContent: "space-between",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <span>heddle.run</span>
          <span>Woven by agents, heddled by humans</span>
          <span>v{VERSION}</span>
        </div>
      </div>
    </footer>
  );
}
