"use client";

/**
 * A monospace editing surface.
 *
 * Still a plain textarea rather than a code editor component: the design system
 * reserves monospace for exactly this, and its own code snippets are set as
 * unhighlighted mono on an inset surface. Matching that is more consistent than
 * importing a syntax theme built from hues this palette does not use.
 */
export default function Editor({
  value,
  onChange,
  label,
  placeholder,
  rows = 18,
  spellCheck = false,
  fill = false,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  rows?: number;
  spellCheck?: boolean;
  /**
   * Take whatever height the pane has, growing and shrinking with it.
   *
   * `rows` stays the flex basis rather than a floor, so the same editor still
   * has a sensible height where the pane is sized by its contents instead —
   * the stacked layout on a narrow screen.
   */
  fill?: boolean;
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
      style={{
        display: "block",
        width: "100%",
        flex: fill ? "1 1 auto" : undefined,
        minHeight: fill ? 0 : undefined,
        resize: fill ? "none" : "vertical",
        padding: "var(--space-4) var(--space-5)",
        border: 0,
        outline: "none",
        background: "var(--bg-inset)",
        color: "var(--text-strong)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--fs-xs)",
        lineHeight: "var(--lh-relaxed)",
      }}
    />
  );
}
