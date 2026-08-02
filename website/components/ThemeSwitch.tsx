"use client";

import { useEffect, useState, type CSSProperties } from "react";
import Glyph from "./Glyph";
import { useTheme } from "@/lib/theme";

/** The hairline square the nav and the playground bar both hang icons in. */
export const iconControl: CSSProperties = {
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

export default function ThemeSwitch() {
  const { dark, toggle } = useTheme();

  /* next-themes resolves the theme only on the client, so the glyph must not
     depend on it until after hydration — the server always paints the
     dark-assumption (sun) and the first client render must match it. */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const showDark = mounted ? dark : true;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={showDark ? "Switch to light theme" : "Switch to dark theme"}
      style={iconControl}
    >
      <Glyph name={showDark ? "sun" : "moon"} size={16} />
    </button>
  );
}
