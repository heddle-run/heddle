"use client";

import Link from "next/link";
import { Icon } from "@/ds-heddle";
import ThemeSwitch, { iconControl } from "./ThemeSwitch";
import { GITHUB_URL, PLAYGROUND_URL } from "@/lib/constants";

/* Destinations only — the numbered sections do their own wayfinding on scroll,
   and the footer carries the full index. One entry for the playground: the
   comparison is a view of it, not a page of its own. */
const links = [
  { label: "Docs", href: "/docs" },
  { label: "Playground", href: PLAYGROUND_URL },
];

export default function Nav() {
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
          <ThemeSwitch />
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="heddle on GitHub"
            style={{ ...iconControl, textDecoration: "none" }}
          >
            <Icon name="github" size={16} />
          </a>
        </div>
      </div>
    </header>
  );
}
