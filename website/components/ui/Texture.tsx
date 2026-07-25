import { cn } from "@/lib/cn";

type Variant =
  | "lines"
  | "warp"
  | "grid"
  | "diagonal"
  | "noise"
  | "warp-inverted"
  | "radial-inverted";

/**
 * Decorative pattern overlay. Depth in this system comes from layered
 * hairline textures rather than shadows, so most sections carry one or two.
 */
export default function Texture({
  variant,
  className,
}: {
  variant: Variant;
  className?: string;
}) {
  return <div aria-hidden className={cn("texture", `texture-${variant}`, className)} />;
}
