"use client";

import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { useReducedMotion } from "motion/react";

/* Stripe's hero has a colourful flowing graphic behind the content; heddle's
   own gradient-thread already names five hues for exactly that kind of
   ribbon, so this draws them as actual flowing strands rather than
   borrowing Stripe's soft airbrushed mesh look. Crisp vector edges, round
   caps, no blur — heddle's own line language (see Icon.jsx), just five
   colours instead of one. Each strand draws itself in on mount, staggered,
   the way the hero's spec window and terminal already do: the loom
   threading itself as the page loads. Reduced motion shows every strand
   fully drawn, still. */
const STRANDS = [
  { color: "#a960ee", width: 10, d: "M -20 90 C 100 40, 180 160, 300 110 S 500 40, 580 100" },
  { color: "#ff333d", width: 9, d: "M -20 200 C 120 260, 200 140, 320 220 S 480 300, 580 230" },
  { color: "#ff8a00", width: 11, d: "M -20 340 C 100 280, 220 400, 340 320 S 500 260, 580 340" },
  { color: "#90e0ff", width: 9, d: "M -20 470 C 130 520, 210 400, 340 460 S 490 540, 580 470" },
  { color: "#ffcb57", width: 10, d: "M -20 580 C 110 620, 230 540, 350 600 S 500 640, 580 580" },
];

export function HeroWeave() {
  const ref = useRef<SVGSVGElement>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (reduce || !ref.current) return;
    const svg = ref.current;
    const ctx = gsap.context(() => {
      const paths = Array.from(svg.querySelectorAll<SVGPathElement>("[data-strand]"));
      const tl = gsap.timeline({ defaults: { ease: "power2.inOut" } });
      paths.forEach((path, i) => {
        tl.to(path, { strokeDashoffset: 0, duration: 1.1 }, i * 0.14);
      });
    });
    return () => ctx.revert();
  }, [reduce]);

  return (
    <svg
      ref={ref}
      aria-hidden="true"
      viewBox="0 0 560 680"
      preserveAspectRatio="xMidYMid slice"
      style={{
        position: "absolute",
        top: -40,
        right: -30,
        width: "112%",
        height: "118%",
        zIndex: -1,
        pointerEvents: "none",
      }}
    >
      {STRANDS.map((s, i) => (
        <path
          key={i}
          data-strand
          d={s.d}
          fill="none"
          stroke={s.color}
          strokeWidth={s.width}
          strokeLinecap="round"
          opacity={0.92}
          pathLength={1}
          strokeDasharray="1 1"
          strokeDashoffset={reduce ? 0 : 1}
        />
      ))}
    </svg>
  );
}
