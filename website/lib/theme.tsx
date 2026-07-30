"use client";

import { useTheme as useNextTheme } from "next-themes";

export function useTheme() {
  const { resolvedTheme, setTheme } = useNextTheme();
  const dark = resolvedTheme !== "light";

  return { dark, toggle: () => setTheme(dark ? "light" : "dark") };
}
