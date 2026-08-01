"use client";

import Link from "next/link";
import { Button, ThemeToggle, Icon } from "@/ds";
import { useTheme } from "@/lib/theme";
import { GITHUB_URL, PLAYGROUND_URL } from "@/lib/constants";
import Wordmark from "./Wordmark";

/* Destinations only. This row used to also carry anchors into the landing
   page's own sections, named after their editorial labels — "Included",
   "Method", "Isolation" — which read as insider vocabulary next to two real
   navigations, and hid the whole row below 960px to fit. The numbered sections
   do their own wayfinding on scroll, and the footer carries the full index.
   The section ids stay put as deep-link targets.

   One entry for the playground: the comparison is a view of it, not a page of
   its own. Its address is another origin once the subdomain is configured, so
   the anchor is chosen per link rather than assumed. */
const links = [
  { label: "Docs", href: "/docs" },
  { label: "Playground", href: PLAYGROUND_URL },
];

export default function Nav() {
  const { dark, toggle } = useTheme();

  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        width: "100%",
        borderBottom: "1px solid var(--border-hairline)",
        background: "var(--surface-chrome)",
        backdropFilter: "blur(var(--blur-chrome))",
      }}
    >
      <div
        className="hd-container"
        style={{
          height: "var(--nav-height)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--space-6)",
        }}
      >
        <Link href="/" aria-label="heddle — home">
          <Wordmark />
        </Link>

        <nav
          aria-label="Primary"
          className="hd-nav-links"
          style={{
            alignItems: "center",
            gap: "var(--space-8)",
            fontSize: "var(--fs-sm)",
            fontWeight: "var(--fw-medium)",
          }}
        >
          {links.map((link) =>
            link.href.startsWith("http") ? (
              <a
                key={link.href}
                href={link.href}
                className="ff-text-transition"
                style={{ color: "var(--text-body)" }}
              >
                {link.label}
              </a>
            ) : (
              <Link
                key={link.href}
                href={link.href}
                className="ff-text-transition"
                style={{ color: "var(--text-body)" }}
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
            gap: "var(--space-4)",
          }}
        >
          <ThemeToggle dark={dark} onToggle={toggle} />
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="heddle on GitHub"
            className="hd-nav-secondary ff-text-transition"
            style={{ color: "var(--text-body)", alignItems: "center" }}
          >
            <Icon name="github" size={18} />
          </a>
          {/* Not /docs — the link two elements to the left already goes there,
              and a CTA that repeats its neighbour is a wasted slot. This is the
              page a reader who has decided actually wants. */}
          <Link href="/docs/getting-started">
            <Button size="sm" beam iconAfter="arrow-right">
              Get started
            </Button>
          </Link>
        </div>
      </div>
    </header>
  );
}
