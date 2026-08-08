"use client";

import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { useReducedMotion } from "motion/react";

/* Stripe's own hero: one large, thick, continuously flowing ribbon, not a
   thin decorative line. This is the same move in heddle's own five hues
   (--gradient-thread) and heddle's own line language — a crisp stroked
   path, not Stripe's soft airbrushed mesh — but sized and animated the way
   Stripe's is: it dominates its side of the hero, and it never sits still.
   A thick primary ribbon carries the full five-stop gradient; a thinner
   echo, offset and dimmer, gives it the layered depth a single line can't.
   Both draw themselves in once on mount, then settle into a slow, endless
   drift — a gentle rotation and a colour wash sliding along the gradient —
   rather than freezing the way the rest of this page's motion does.

   The draw-in measures each path's real length with getTotalLength() rather
   than the pathLength-attribute normalization trick used elsewhere on this
   page (Definition, AnimatedTerminal): with these longer multi-curve paths
   pathLength normalization silently failed in testing (dashes stayed sized
   in raw units, effectively invisible), where the classic getTotalLength
   approach is unaffected by path complexity. The group starts at opacity 0
   so there is no flash of the fully-drawn ribbon before the dash offsets are
   set. Reduced motion skips all of it and shows the ribbon drawn, still. */
const STOPS = [
  { offset: "0%", color: "#a960ee" },
  { offset: "25%", color: "#ff333d" },
  { offset: "50%", color: "#ff8a00" },
  { offset: "75%", color: "#90e0ff" },
  { offset: "100%", color: "#ffcb57" },
];

export function HeroWeave() {
  const svgRef = useRef<SVGSVGElement>(null);
  const gradRef = useRef<SVGLinearGradientElement>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (reduce || !svgRef.current) return;
    const svg = svgRef.current;
    const grad = gradRef.current;
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
        draw.to(path, { strokeDashoffset: 0, duration: 1.4 }, i * 0.2);
      });

      draw.eventCallback("onComplete", () => {
        if (group) {
          gsap.to(group, {
            rotate: 2.2,
            x: 14,
            y: -16,
            duration: 10,
            ease: "sine.inOut",
            yoyo: true,
            repeat: -1,
            transformOrigin: "50% 50%",
          });
        }
        if (grad) {
          gsap.to(grad, {
            attr: { x1: -160, x2: 660 },
            duration: 8,
            ease: "sine.inOut",
            yoyo: true,
            repeat: -1,
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
          <linearGradient
            ref={gradRef}
            id="hero-ribbon-gradient"
            gradientUnits="userSpaceOnUse"
            x1={0}
            y1={0}
            x2={720}
            y2={920}
          >
            {STOPS.map((s) => (
              <stop key={s.offset} offset={s.offset} stopColor={s.color} />
            ))}
          </linearGradient>
        </defs>
        <g data-ribbon-group style={{ opacity: reduce ? 1 : 0 }}>
          <path
            data-strand
            d="M 600 -80 C 480 100, 700 260, 540 440 S 380 700, 600 840 S 760 960, 660 1020"
            fill="none"
            stroke="url(#hero-ribbon-gradient)"
            strokeWidth={140}
            strokeLinecap="round"
            opacity={0.94}
          />
          <path
            data-strand
            d="M 740 -40 C 640 180, 820 340, 700 520 S 560 760, 760 900"
            fill="none"
            stroke="url(#hero-ribbon-gradient)"
            strokeWidth={64}
            strokeLinecap="round"
            opacity={0.55}
          />
        </g>
      </svg>
    </div>
  );
}
