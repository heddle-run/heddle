import { cn } from "@/lib/cn";

/** Monospace metadata: section numbers, eyebrows, categories, dates. */
export default function Label({
  children,
  className,
  as: Tag = "p",
}: {
  children: React.ReactNode;
  className?: string;
  as?: "p" | "span" | "div";
}) {
  return (
    <Tag
      className={cn(
        "font-mono text-xs uppercase tracking-[0.2em] text-muted-ink",
        className,
      )}
    >
      {children}
    </Tag>
  );
}
