"use client";

import { useTheme as useNextTheme } from "next-themes";

/**
 * Theme access for the design system's ThemeToggle.
 *
 * next-themes is the single source of truth, because fumadocs already runs it
 * for the /docs shell — using anything else meant two theme systems and a
 * toggle in the docs sidebar that did nothing. It writes `class="dark"` on
 * <html>, which is exactly the hook the design system's tokens key on, and it
 * injects its own pre-paint script so there is no flash.
 */
export function useTheme() {
  const { resolvedTheme, setTheme } = useNextTheme();

  // Before mount resolvedTheme is undefined; defaulting to dark matches both
  // the server render and the configured default.
  const dark = resolvedTheme !== "light";

  return { dark, toggle: () => setTheme(dark ? "light" : "dark") };
}
