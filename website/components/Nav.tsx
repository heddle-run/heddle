"use client";

import Link from "next/link";
import { Button, ThemeToggle, Icon } from "@/ds";
import { useTheme } from "@/lib/theme";
import { GITHUB_URL } from "@/lib/constants";
import Wordmark from "./Wordmark";

const links = [
  { label: "Method", href: "/#method" },
  { label: "Isolation", href: "/#safe" },
  { label: "Compare", href: "/compare" },
  { label: "Playground", href: "/playground" },
  { label: "Docs", href: "/docs" },
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
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="ff-text-transition"
              style={{ color: "var(--text-body)" }}
            >
              {link.label}
            </Link>
          ))}
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
          <Link href="/docs">
            <Button size="sm" beam iconAfter="arrow-right">
              Get started
            </Button>
          </Link>
        </div>
      </div>
    </header>
  );
}
