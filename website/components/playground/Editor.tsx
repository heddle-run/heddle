"use client";

import { cn } from "@/lib/cn";

/**
 * A monospace editing surface.
 *
 * A plain textarea rather than a code editor component: the design system has
 * no colour to highlight with, and every syntax theme worth importing is built
 * from hues this site does not have. Monospace on paper, with the caret and
 * selection inverted, is the honest version.
 */
export default function Editor({
  value,
  onChange,
  label,
  placeholder,
  rows = 18,
  spellCheck = false,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  rows?: number;
  spellCheck?: boolean;
  className?: string;
}) {
  return (
    <textarea
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      rows={rows}
      spellCheck={spellCheck}
      autoCapitalize="off"
      autoCorrect="off"
      autoComplete="off"
      className={cn(
        "block w-full resize-y bg-paper px-5 py-4 font-mono text-xs leading-relaxed text-ink",
        "placeholder:text-muted-ink focus:outline-none",
        "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink",
        className,
      )}
    />
  );
}
