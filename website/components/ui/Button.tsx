import Link from "next/link";
import { cn } from "@/lib/cn";

const base =
  "inline-flex items-center justify-center gap-3 border-2 px-8 py-4 font-mono text-xs uppercase tracking-[0.2em] transition-colors duration-100 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-[3px] focus-visible:outline-ink";

const variants = {
  /** Black slab. Inverts to paper on hover. */
  primary: "border-ink bg-ink text-paper hover:bg-paper hover:text-ink",
  /** Outline. Fills black on hover. */
  secondary: "border-ink bg-transparent text-ink hover:bg-ink hover:text-paper",
  /** Outline on an inverted surface. */
  inverted:
    "border-paper bg-paper text-ink hover:bg-transparent hover:text-paper",
  /** Reads as a text link. */
  ghost:
    "border-transparent px-0 py-2 text-ink underline-offset-[6px] hover:underline focus-visible:outline-offset-2",
} as const;

type Props = {
  children: React.ReactNode;
  href: string;
  variant?: keyof typeof variants;
  className?: string;
  external?: boolean;
};

export default function Button({
  children,
  href,
  variant = "primary",
  className,
  external,
}: Props) {
  const classes = cn(base, variants[variant], className);

  if (external) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={classes}
      >
        {children}
      </a>
    );
  }

  return (
    <Link href={href} className={classes}>
      {children}
    </Link>
  );
}
