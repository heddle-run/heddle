"use client";

import type { CSSProperties, ReactNode } from "react";

/**
 * The controls that sit inside a navy window.
 *
 * The system's own `Select`, `Input` and `IconButton` are paper controls —
 * raised white, hairline border, soft shadow — and putting one inside a code
 * window reads as a hole punched in it. `IconButton` already ships an
 * `inverse` variant for exactly this, so these three follow it: the same
 * geometry and the same 5px control radius, on the inverse ramp.
 */

const SIZES = { sm: 28, md: 32 } as const;

const surface: CSSProperties = {
  background: "var(--surface-code-alt)",
  border: "1px solid var(--border-inverse)",
  borderRadius: "var(--radius-control)",
  color: "var(--code-fg)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-code-sm)",
  transition: "var(--transition-control)",
};

/* The chevron is the vendored Select's, redrawn on the slate the inverse ramp
   uses for secondary marks — the paper one is a warm grey that disappears
   against navy. */
const CHEVRON =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238898aa' stroke-width='2'><path d='m6 9 6 6 6-6'/></svg>\") no-repeat right 8px center";

export function WindowSelect({
  options,
  size = "sm",
  style,
  ...rest
}: {
  options: readonly string[];
  size?: keyof typeof SIZES;
  style?: CSSProperties;
} & Record<string, unknown>) {
  return (
    <select
      className="hds-window-control"
      style={{
        ...surface,
        height: SIZES[size],
        padding: "0 26px 0 8px",
        background: `var(--surface-code-alt) ${CHEVRON}`,
        appearance: "none",
        cursor: "pointer",
        ...style,
      }}
      {...rest}
    >
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

export function WindowInput({
  size = "sm",
  style,
  ...rest
}: {
  size?: keyof typeof SIZES;
  style?: CSSProperties;
} & Record<string, unknown>) {
  return (
    <input
      className="hds-code-input hds-window-control"
      style={{
        ...surface,
        height: SIZES[size],
        padding: "0 var(--space-3)",
        outline: "none",
        ...style,
      }}
      {...rest}
    />
  );
}

export function WindowIconButton({
  label,
  onClick,
  size = "sm",
  bordered = true,
  children,
  ...rest
}: {
  label: string;
  onClick: () => void;
  size?: keyof typeof SIZES;
  /** Off when the button is already fenced by a hairline of its own. */
  bordered?: boolean;
  children: ReactNode;
} & Record<string, unknown>) {
  return (
    <button
      type="button"
      className="hds-window-control"
      aria-label={label}
      onClick={onClick}
      style={{
        ...surface,
        width: SIZES[size],
        height: SIZES[size],
        display: "grid",
        placeItems: "center",
        flex: "0 0 auto",
        background: bordered ? "var(--surface-code-alt)" : "transparent",
        border: bordered ? "1px solid var(--border-inverse)" : 0,
        borderRadius: bordered ? "var(--radius-control)" : 0,
        color: "var(--slate-400)",
        cursor: "pointer",
      }}
      {...rest}
    >
      {children}
    </button>
  );
}
