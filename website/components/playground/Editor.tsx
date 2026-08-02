"use client";

/* Code is always navy in this system, and a textarea a reader types a spec
   into is code — so the editing surface is the inside of the window rather
   than a field sitting in one. It carries no border of its own: the window
   around it already is the border. */
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
  fill?: boolean;
}) {
  return (
    <textarea
      className="hds-code-input"
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
        background: "transparent",
        color: "var(--code-fg)",
        caretColor: "var(--cyan-500)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--fs-code)",
        lineHeight: "var(--lh-code)",
        letterSpacing: "var(--ls-mono)",
      }}
    />
  );
}
