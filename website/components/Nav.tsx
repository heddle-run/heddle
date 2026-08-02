"use client";

import Link from "next/link";
import { useTheme } from "@/lib/theme";
import {
  AGENT_SPEC_URL,
  GITHUB_URL,
  PLAYGROUND_URL,
  VERSION,
} from "@/lib/constants";

/* Destinations only — the numbered sections do their own wayfinding on scroll,
   and the footer carries the full index. One entry for the playground: the
   comparison is a view of it, not a page of its own. */
const links = [
  { label: "Docs", href: "/docs" },
  { label: "Spec", href: AGENT_SPEC_URL, external: true },
  { label: "Playground", href: PLAYGROUND_URL },
];

export default function Nav() {
  const { dark, toggle } = useTheme();

  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 30,
        background: "color-mix(in srgb, var(--surface-page) 85%, transparent)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        borderBottom: "1px solid var(--border-hairline)",
      }}
    >
      <div
        className="hds-container"
        style={{ height: 60, display: "flex", alignItems: "center", gap: 24 }}
      >
        <Link
          href="/"
          aria-label="heddle — home"
          style={{
            fontWeight: "var(--fw-medium)",
            fontSize: 17,
            letterSpacing: "-0.02em",
            color: "var(--text-strong)",
            textDecoration: "none",
          }}
        >
          heddle
        </Link>

        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text-subtle)",
            border: "1px solid var(--border-default)",
            borderRadius: "var(--radius-pill)",
            padding: "2px 8px",
            whiteSpace: "nowrap",
          }}
        >
          v{VERSION}
        </span>

        <nav
          aria-label="Primary"
          className="hds-nav-links"
          style={{ gap: 22, marginLeft: "auto", fontSize: 14 }}
        >
          {links.map((link) =>
            link.href.startsWith("http") ? (
              <a
                key={link.label}
                href={link.href}
                {...(link.external
                  ? { target: "_blank", rel: "noopener noreferrer" }
                  : {})}
                style={{ color: "var(--text-muted)", textDecoration: "none" }}
              >
                {link.label}
              </a>
            ) : (
              <Link
                key={link.label}
                href={link.href}
                style={{ color: "var(--text-muted)", textDecoration: "none" }}
              >
                {link.label}
              </Link>
            ),
          )}
        </nav>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginLeft: "auto",
          }}
          className="hds-nav-actions"
        >
          <button
            type="button"
            onClick={toggle}
            aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
            style={{
              height: 30,
              padding: "0 12px",
              cursor: "pointer",
              fontFamily: "var(--font-mono)",
              fontSize: 11.5,
              letterSpacing: "0.06em",
              borderRadius: "var(--radius-control)",
              border: "1px solid var(--border-default)",
              background: "transparent",
              color: "var(--text-muted)",
              transition: "var(--transition-control)",
            }}
          >
            {dark ? "Light" : "Dark"}
          </button>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: 14,
              color: "var(--text-strong)",
              textDecoration: "none",
            }}
          >
            GitHub
          </a>
        </div>
      </div>
    </header>
  );
}
