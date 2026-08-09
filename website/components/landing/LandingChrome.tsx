"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Icon } from "@/ds-heddle";
import ThemeSwitch, { iconControl } from "@/components/ThemeSwitch";
import { useReducedMotion } from "motion/react";
import { GITHUB_URL, PLAYGROUND_URL } from "@/lib/constants";

/* The landing page's own chrome, kage-style: a fixed bar that starts
   transparent over the loom and gains its paper blur once the page moves,
   plus a right-edge chapter rail — one dot per chapter, the active one
   named. The shared Nav.tsx stays as-is for /library and the 404; this
   file is mounted only by app/page.tsx.

   One IntersectionObserver feeds both the bar's chapter indicator and the
   rail, keyed to the Chapter wrapper ids in app/page.tsx. */

export const CHAPTERS = [
  { id: "start", label: "Loom" },
  { id: "included", label: "001 · What you can build" },
  { id: "position", label: "002 · How it works" },
  { id: "method", label: "003 · First run" },
  { id: "runtimes", label: "004 · Where it runs" },
  { id: "isolation", label: "005 · Safety" },
  { id: "definition", label: "Definition" },
  { id: "faq", label: "006 · Questions" },
  { id: "begin", label: "Thread the loom" },
];

const links = [
  { label: "Docs", href: "/docs" },
  { label: "Library", href: "/library" },
  { label: "Playground", href: PLAYGROUND_URL },
];

export default function LandingChrome() {
  const [active, setActive] = useState(0);
  const reduce = useReducedMotion();

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = CHAPTERS.findIndex((c) => c.id === entry.target.id);
          if (index >= 0) setActive(index);
        }
      },
      /* A band across the viewport's middle: the chapter holding the
         centre of the screen is the active one. */
      { rootMargin: "-45% 0px -45% 0px" },
    );
    for (const chapter of CHAPTERS) {
      const el = document.getElementById(chapter.id);
      if (el) observer.observe(el);
    }
    return () => {
      observer.disconnect();
    };
  }, []);

  const jump = (id: string) => {
    document.getElementById(id)?.scrollIntoView({
      behavior: reduce ? "auto" : "smooth",
      block: "start",
    });
  };

  return (
    <>
      {/* The glass bar is always on — it started transparent over the hero
          and blurred in after 32px of scroll, but the braid sweeps under
          the bar from the first frame, so the hero state read as floating
          links on busy threads. */}
      <header
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 40,
          background: "color-mix(in srgb, var(--surface-page) 80%, transparent)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          borderBottom: "1px solid var(--border-hairline)",
        }}
      >
        <div
          className="hds-container"
          style={{ height: 60, display: "flex", alignItems: "center", gap: 20 }}
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
            className="hds-nav-links"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10.5,
              letterSpacing: "var(--ls-label)",
              textTransform: "uppercase",
              color: "var(--text-subtle)",
            }}
          >
            {CHAPTERS[active].label}
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
            className="hds-nav-actions"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              marginLeft: "auto",
            }}
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

      <nav aria-label="Chapters" className="hds-chapter-rail">
        {CHAPTERS.map((chapter, index) => (
          <button
            key={chapter.id}
            type="button"
            onClick={() => jump(chapter.id)}
            aria-label={chapter.label}
            aria-current={index === active ? "true" : undefined}
            className="hds-chapter-dot"
            data-active={index === active || undefined}
          >
            <span className="hds-chapter-dot-mark" aria-hidden="true" />
            <span className="hds-chapter-dot-label" aria-hidden="true">
              {chapter.label}
            </span>
          </button>
        ))}
      </nav>
    </>
  );
}
