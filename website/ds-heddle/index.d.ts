/**
 * Prop contracts for the vendored Heddle design system.
 *
 * The components themselves are plain `.jsx` (kept that way so upstream updates
 * merge cleanly — see DEVIATIONS.md). This file is the typed surface the site
 * codes against; it mirrors the `.d.ts` files the upstream project ships.
 */

import type { CSSProperties, ReactNode } from "react";

/** A key in Icon's path table, e.g. "terminal", "shield", "arrowRight". */
export type IconName =
  | "terminal"
  | "copy"
  | "check"
  | "arrowRight"
  | "shield"
  | "file"
  | "zap"
  | "github"
  | "chevronDown"
  | "x"
  | "menu";

/* ── core ─────────────────────────────────────────────────────────────── */

export function Badge(props: {
  tone?: "neutral" | "accent" | "teal" | "success" | "warning" | "danger" | "inverse";
  mono?: boolean;
  dot?: boolean;
  children?: ReactNode;
  style?: CSSProperties;
}): ReactNode;

export function Button(
  props: {
    variant?: "primary" | "accent" | "secondary" | "ghost" | "link";
    size?: "sm" | "md" | "lg";
    disabled?: boolean;
    fullWidth?: boolean;
    iconLeft?: ReactNode;
    iconRight?: ReactNode;
    as?: "button" | "a";
    href?: string;
    onClick?: (e: unknown) => void;
    children?: ReactNode;
    style?: CSSProperties;
  } & Record<string, unknown>,
): ReactNode;

export function Card(props: {
  title?: ReactNode;
  eyebrow?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  interactive?: boolean;
  padding?: number | string;
  style?: CSSProperties;
}): ReactNode;

export function Checkbox(
  props: {
    label?: ReactNode;
    description?: ReactNode;
    checked?: boolean;
    onChange?: (e: unknown) => void;
    disabled?: boolean;
  } & Record<string, unknown>,
): ReactNode;

export function Dialog(props: {
  open?: boolean;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  onClose?: () => void;
  width?: number | string;
}): ReactNode;

export function Icon(props: {
  name?: IconName;
  size?: number;
  strokeWidth?: number;
  color?: string;
  style?: CSSProperties;
}): ReactNode;

export function IconButton(props: {
  name?: IconName;
  variant?: "ghost" | "secondary" | "inverse";
  size?: number;
  label?: string;
  onClick?: () => void;
  style?: CSSProperties;
}): ReactNode;

export function Input(
  props: {
    label?: ReactNode;
    hint?: ReactNode;
    error?: ReactNode;
    prefix?: ReactNode;
    suffix?: ReactNode;
    mono?: boolean;
    size?: "sm" | "md";
    style?: CSSProperties;
  } & Record<string, unknown>,
): ReactNode;

export function Radio(props: {
  label?: ReactNode;
  description?: ReactNode;
  checked?: boolean;
  onChange?: (e: unknown) => void;
  name?: string;
  value?: string;
  disabled?: boolean;
}): ReactNode;

export function Select(
  props: {
    label?: ReactNode;
    hint?: ReactNode;
    options?: Array<string | { value: string; label: ReactNode }>;
    size?: "sm" | "md";
    style?: CSSProperties;
  } & Record<string, unknown>,
): ReactNode;

export function Switch(props: {
  checked?: boolean;
  onChange?: (next: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
}): ReactNode;

export function Tabs(props: {
  tabs?: Array<string | { value: string; label: ReactNode }>;
  value?: string;
  onChange?: (value: string) => void;
  variant?: "underline" | "pill";
}): ReactNode;

export function Tag(props: {
  children?: ReactNode;
  onRemove?: () => void;
  style?: CSSProperties;
}): ReactNode;

export function Tooltip(props: {
  label?: ReactNode;
  side?: "top" | "bottom";
  children?: ReactNode;
}): ReactNode;

/* ── marketing ────────────────────────────────────────────────────────── */

export function CodeBlock(props: {
  code?: string;
  language?: string;
  filename?: string;
  lines?: string[];
  copyable?: boolean;
  style?: CSSProperties;
}): ReactNode;

export function FeatureListItem(props: {
  index?: ReactNode;
  title?: ReactNode;
  children?: ReactNode;
  style?: CSSProperties;
}): ReactNode;

export function InstallCommand(props: {
  command?: string;
  style?: CSSProperties;
}): ReactNode;

export function SectionHeading(props: {
  number?: ReactNode;
  eyebrow?: ReactNode;
  title?: ReactNode;
  lede?: ReactNode;
  align?: "left" | "center";
  style?: CSSProperties;
}): ReactNode;

export function Stat(props: {
  value?: ReactNode;
  label?: ReactNode;
  note?: ReactNode;
  align?: "left" | "center" | "right";
}): ReactNode;

export type TerminalLine =
  | string
  | { text: string; kind?: "prompt" | "tool" | "ok" | "dim" | "out" };

export function Terminal(props: {
  lines?: TerminalLine[];
  title?: string;
  style?: CSSProperties;
}): ReactNode;
