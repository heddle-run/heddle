import { cn } from "@/lib/cn";

/** The measure every section is set to. */
export default function Container({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mx-auto w-full max-w-6xl px-6 md:px-8 lg:px-12", className)}>
      {children}
    </div>
  );
}
