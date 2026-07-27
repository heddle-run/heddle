/**
 * Prop contracts for the vendored FormFlow design system.
 *
 * The components themselves are plain `.jsx` (kept that way so upstream updates
 * merge cleanly — see DEVIATIONS.md). This file is the typed surface the site
 * codes against; it mirrors the `.d.ts` files the upstream project ships.
 */

import type {
  ButtonHTMLAttributes,
  CSSProperties,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from "react";

/** A key in the Icon registry, e.g. "arrow-right". Unknown names throw in dev. */
export type IconName = string;

export type RadiusToken =
  | "none"
  | "xs"
  | "sm"
  | "md"
  | "lg"
  | "xl"
  | "2xl"
  | "full";

type Base<E = HTMLElement> = Omit<HTMLAttributes<E>, "title"> & {
  style?: CSSProperties;
  className?: string;
};

/* ── core ─────────────────────────────────────────────────────────────── */

export function Icon(
  props: {
    name: IconName;
    size?: number;
    color?: string;
    strokeWidth?: number;
    className?: string;
    style?: CSSProperties;
  } & Omit<HTMLAttributes<SVGSVGElement>, "color">,
): JSX.Element | null;

export function Button(
  props: {
    variant?: "solid" | "outline" | "subtle" | "ghost" | "accent";
    size?: "sm" | "md" | "lg";
    shape?: "pill" | "rounded";
    icon?: IconName;
    iconAfter?: IconName;
    beam?: boolean;
    block?: boolean;
    disabled?: boolean;
    children?: ReactNode;
  } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & {
      type?: "button" | "submit" | "reset";
    },
): JSX.Element;

export function IconButton(
  props: {
    icon: IconName;
    size?: "sm" | "md" | "lg";
    variant?: "solid" | "ghost";
    label?: string;
  } & ButtonHTMLAttributes<HTMLButtonElement>,
): JSX.Element;

export function Badge(
  props: {
    tone?: "accent" | "neutral" | "solid" | "gradient";
    pulse?: boolean;
    uppercase?: boolean;
    beam?: boolean;
    children?: ReactNode;
    title?: string;
  } & Base<HTMLSpanElement>,
): JSX.Element;

export function BoxedFrame(
  props: {
    /** "all" | "diagonal" | "none", or an explicit list of tl/tr/bl/br. */
    corners?: "all" | "diagonal" | "none" | Array<"tl" | "tr" | "bl" | "br">;
    /** "all" | "horizontal" | "none", or an explicit list of edges. */
    edges?:
      | "all"
      | "horizontal"
      | "none"
      | Array<"top" | "bottom" | "left" | "right">;
    beam?: boolean;
    pad?: number | string;
    children?: ReactNode;
  } & Base<HTMLDivElement>,
): JSX.Element;

export function Card(
  props: {
    radius?: RadiusToken;
    tone?: "card" | "elevated" | "sunken" | "glass";
    pad?: number | string;
    sheen?: boolean;
    beam?: boolean;
    hoverBorder?: boolean;
    children?: ReactNode;
  } & Base<HTMLDivElement>,
): JSX.Element;

export function Chip(
  props: {
    icon?: IconName;
    /** Border and glyph colour on hover. Defaults to the brand accent. */
    accent?: string;
    children?: ReactNode;
  } & Base<HTMLDivElement>,
): JSX.Element;

export function WindowChrome(
  props: {
    beam?: boolean;
    children?: ReactNode;
  } & Base<HTMLDivElement>,
): JSX.Element;

/* ── forms ────────────────────────────────────────────────────────────── */

export function Field(
  props: {
    label?: ReactNode;
    hint?: ReactNode;
    children?: ReactNode;
  } & Base<HTMLDivElement>,
): JSX.Element;

export function Input(
  props: {
    size?: "sm" | "md";
    invalid?: boolean;
  } & Omit<InputHTMLAttributes<HTMLInputElement>, "size">,
): JSX.Element;

export function Select(
  props: {
    options?: readonly string[];
    style?: CSSProperties;
  } & Omit<SelectHTMLAttributes<HTMLSelectElement>, "style">,
): JSX.Element;

export function Switch(props: {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  label?: ReactNode;
  style?: CSSProperties;
}): JSX.Element;

export function Checkbox(props: {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  label?: ReactNode;
  style?: CSSProperties;
}): JSX.Element;

export function RangeSlider(props: {
  value?: number;
  min?: number;
  max?: number;
  onChange?: (value: number) => void;
  readout?: ReactNode;
  style?: CSSProperties;
}): JSX.Element;

export function FormCard(
  props: {
    title?: ReactNode;
    subtitle?: ReactNode;
    selected?: boolean;
    children?: ReactNode;
  } & Base<HTMLDivElement>,
): JSX.Element;

/* ── marketing ────────────────────────────────────────────────────────── */

export function SectionHeading(
  props: {
    /** Split the heading into words so each can take its own hover hue. */
    words?: string[];
    sub?: ReactNode;
    level?: 1 | 2 | 3;
    align?: "center" | "left";
  } & Base<HTMLDivElement>,
): JSX.Element;

export function ThemeToggle(
  props: {
    dark?: boolean;
    onToggle?: () => void;
  } & ButtonHTMLAttributes<HTMLButtonElement>,
): JSX.Element;

export function FeatureCard(
  props: {
    icon?: IconName;
    hue?: string;
    title?: ReactNode;
    body?: ReactNode;
    /** The tall bento cell: bigger type, icon in a tinted tile, copy bottom-aligned. */
    feature?: boolean;
    /** Adds the blurred accent orb behind the cell. */
    glow?: boolean;
    children?: ReactNode;
  } & Base<HTMLDivElement>,
): JSX.Element;

export function TemplateCard(
  props: {
    title?: ReactNode;
    body?: ReactNode;
    hue?: string;
    preview?: ReactNode;
  } & Base<HTMLDivElement>,
): JSX.Element;

export function PricingCard(
  props: {
    name?: ReactNode;
    price?: ReactNode;
    period?: ReactNode;
    blurb?: ReactNode;
    features?: string[];
    cta?: ReactNode;
    featured?: boolean;
    hue?: string;
  } & Base<HTMLDivElement>,
): JSX.Element;

export function StepCard(
  props: {
    icon?: IconName;
    title?: ReactNode;
    body?: ReactNode;
    hue?: string;
  } & Base<HTMLDivElement>,
): JSX.Element;

export function Marquee(
  props: {
    eyebrow?: ReactNode;
    /** Seconds for one full loop. */
    speed?: number;
    children?: ReactNode;
  } & Base<HTMLDivElement>,
): JSX.Element;

/* ── effects ──────────────────────────────────────────────────────────── */

export function Backdrop(
  props?: {
    swirls?: boolean;
    grid?: boolean;
    noise?: boolean;
  } & Base<HTMLDivElement>,
): JSX.Element;
