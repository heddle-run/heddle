"use client";

import Link from "next/link";
import { useEffect, useState, type CSSProperties } from "react";
import { Icon } from "@/ds-heddle";
import { useTheme } from "@/lib/theme";
import {
  AGENT_SPEC_URL,
  GITHUB_URL,
  PLAYGROUND_URL,
} from "@/lib/constants";

/* Sun/moon are site-specific (the vendored Icon set has no theme glyphs and
   takes no site additions), so they live here as inline lucide paths drawn
   to the same 24-grid and stroke as ds-heddle's Icon. */
function ThemeGlyph({ dark }: { dark: boolean }) {
  const paths = dark
    ? [
        "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
        "M12 2v2",
        "M12 20v2",
        "m4.93 4.93 1.41 1.41",
        "m17.66 17.66 1.41 1.41",
        "M2 12h2",
        "M20 12h2",
        "m6.34 17.66-1.41 1.41",
        "m19.07 4.93-1.41 1.41",
      ]
    : ["M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"];
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: "0 0 auto" }}
      aria-hidden="true"
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

const iconControl: CSSProperties = {
  width: 30,
  height: 30,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  borderRadius: "var(--radius-control)",
  border: "1px solid var(--border-default)",
  background: "transparent",
  color: "var(--text-muted)",
  transition: "var(--transition-control)",
};

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

  /* next-themes resolves the theme only on the client, so the glyph must not
     depend on it until after hydration — the server always paints the
     dark-assumption (sun) and the first client render must match it. */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const showDark = mounted ? dark : true;

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
            aria-label={
              showDark ? "Switch to light theme" : "Switch to dark theme"
            }
            style={iconControl}
          >
            <ThemeGlyph dark={showDark} />
          </button>
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
