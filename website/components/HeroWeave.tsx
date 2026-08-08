"use client";

import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { useReducedMotion } from "motion/react";

/* Stripe's hero graphic is a soft, continuously-shaded silk surface, not a
   couple of crisp lines — the first two passes at this (thin threads, then
   two clean thick strokes) both read as decoration behind the windows
   rather than the thing itself. This version chases the actual technique:
   five thick, solid-colour bands — one per --gradient-thread hue — heavily
   overlapping and gaussian-blurred as one group, so the blur does the work
   a gradient mesh shader would: it blends the overlaps into smooth,
   continuous colour transitions instead of hard edges between strands.
   Heddle's own five hues, Stripe's own rendering idea.

   Draw-in still measures each path's real length with getTotalLength()
   (see the DEVIATIONS note in BRAND.md on why, not the pathLength
   attribute), then the whole group settles into a slow endless drift —
   rotation plus a small translate — so it never sits still once drawn.
   Reduced motion shows it fully drawn, still, no blur animation either. */
const BANDS = [
  {
    color: "#a960ee",
    width: 210,
    d: "M 580 -100 C 460 100, 680 260, 520 440 S 360 700, 580 860 S 740 980, 640 1040",
  },
  {
    color: "#ff333d",
    width: 175,
    d: "M 660 -80 C 560 140, 760 300, 620 480 S 480 720, 680 880 S 820 1000, 700 1040",
  },
  {
    color: "#ff8a00",
    width: 155,
    d: "M 500 -60 C 400 160, 600 320, 460 500 S 320 740, 520 900 S 660 1000, 560 1040",
  },
  {
    color: "#90e0ff",
    width: 135,
    d: "M 720 -40 C 640 180, 820 340, 700 520 S 580 760, 780 920 S 900 1000, 800 1040",
  },
  {
    color: "#ffcb57",
    width: 115,
    d: "M 440 -100 C 340 120, 540 280, 400 460 S 260 700, 460 860 S 600 960, 500 1000",
  },
];

export function HeroWeave() {
  const svgRef = useRef<SVGSVGElement>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (reduce || !svgRef.current) return;
    const svg = svgRef.current;
    const group = svg.querySelector<SVGGElement>("[data-ribbon-group]");

    const ctx = gsap.context(() => {
      const paths = Array.from(svg.querySelectorAll<SVGPathElement>("[data-strand]"));

      paths.forEach((path) => {
        const length = path.getTotalLength();
        gsap.set(path, { strokeDasharray: length, strokeDashoffset: length });
      });
      if (group) gsap.set(group, { opacity: 1 });

      const draw = gsap.timeline({ defaults: { ease: "power2.inOut" } });
      paths.forEach((path, i) => {
        draw.to(path, { strokeDashoffset: 0, duration: 1.5 }, i * 0.16);
      });

      draw.eventCallback("onComplete", () => {
        if (group) {
          gsap.to(group, {
            rotate: 2.4,
            x: 18,
            y: -20,
            duration: 11,
            ease: "sine.inOut",
            yoyo: true,
            repeat: -1,
            transformOrigin: "50% 50%",
          });
        }
      });
    });
    return () => ctx.revert();
  }, [reduce]);

  return (
    <div
      style={{
        position: "absolute",
        top: -220,
        right: -600,
        bottom: 0,
        width: "280%",
        overflow: "hidden",
        zIndex: -1,
        pointerEvents: "none",
      }}
    >
      <svg
        ref={svgRef}
        aria-hidden="true"
        viewBox="0 0 720 920"
        preserveAspectRatio="xMidYMid slice"
        style={{ width: "100%", height: "100%", display: "block" }}
      >
        <defs>
          <filter
            id="hero-ribbon-blur"
            x="-60%"
            y="-60%"
            width="220%"
            height="220%"
          >
            <feGaussianBlur stdDeviation="34" />
          </filter>
        </defs>
        <g data-ribbon-group style={{ opacity: reduce ? 1 : 0 }}>
          <g filter="url(#hero-ribbon-blur)">
            {BANDS.map((b) => (
              <path
                key={b.color}
                data-strand
                d={b.d}
                fill="none"
                stroke={b.color}
                strokeWidth={b.width}
                strokeLinecap="round"
                opacity={0.92}
              />
            ))}
          </g>
        </g>
      </svg>
    </div>
  );
}
