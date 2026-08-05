import { useId } from "react";
import type { CSSProperties } from "react";

/* A real plain weave, not a stripe: two warp columns and two weft rows per
   tile, crossing at four points. At each crossing the thread that is "on
   top" is redrawn at full strength over the one passing behind it, and
   which thread wins alternates in a checkerboard — over, under, under,
   over — the way an actual tabby weave alternates every row and column.
   That 2x2 alternation is the whole reason the tile is two threads wide
   rather than one: a single warp/weft pair tiles into a plain grid, not a
   weave. `variant="strong"` is for a section painting its own surface
   (Hero, Position, CTA); `"faint"` is the whisper behind plain paper.
   `inverse` swaps to --border-inverse, matching the rule that always-dark
   surfaces never use --border-hairline. */
export function WeaveTexture({
  variant = "faint",
  inverse = false,
  style,
}: {
  variant?: "faint" | "strong";
  inverse?: boolean;
  style?: CSSProperties;
}) {
  const id = useId().replace(/[:]/g, "");
  const patternId = `weave-${id}`;
  const color = inverse ? "var(--border-inverse)" : "var(--border-hairline)";
  const under = variant === "strong" ? 0.5 : 0.16;
  const over = variant === "strong" ? 1 : 0.34;

  const TILE = 48;
  const A = 12;
  const B = 36;
  const THREAD = 2;
  const PATCH = 7;

  return (
    <svg
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        ...style,
      }}
    >
      <defs>
        <pattern
          id={patternId}
          width={TILE}
          height={TILE}
          patternUnits="userSpaceOnUse"
        >
          {/* the under-layer: every warp and weft thread, dimmed */}
          <g stroke={color} strokeWidth={THREAD} opacity={under}>
            <line x1={A} y1={0} x2={A} y2={TILE} />
            <line x1={B} y1={0} x2={B} y2={TILE} />
            <line x1={0} y1={A} x2={TILE} y2={A} />
            <line x1={0} y1={B} x2={TILE} y2={B} />
          </g>
          {/* the over-layer: whichever thread wins each crossing, full strength */}
          <g fill={color} opacity={over}>
            <rect x={A - THREAD / 2} y={A - PATCH / 2} width={THREAD} height={PATCH} />
            <rect x={B - PATCH / 2} y={A - THREAD / 2} width={PATCH} height={THREAD} />
            <rect x={A - PATCH / 2} y={B - THREAD / 2} width={PATCH} height={THREAD} />
            <rect x={B - THREAD / 2} y={B - PATCH / 2} width={THREAD} height={PATCH} />
          </g>
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${patternId})`} />
    </svg>
  );
}
