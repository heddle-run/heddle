"use client";

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
