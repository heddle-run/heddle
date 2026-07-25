import { cn } from "@/lib/cn";

const weights = {
  hairline: "h-px bg-hairline",
  thin: "h-px bg-ink",
  medium: "h-0.5 bg-ink",
  thick: "h-1 bg-ink",
  ultra: "h-2 bg-ink",
} as const;

/** A horizontal rule. Sections are separated by mass, not space alone. */
export default function Rule({
  weight = "thick",
  className,
}: {
  weight?: keyof typeof weights;
  className?: string;
}) {
  return <hr aria-hidden className={cn("border-0", weights[weight], className)} />;
}
