"use client";

import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useReducedMotion } from "motion/react";
import { definition } from "@/lib/constants";

gsap.registerPlugin(ScrollTrigger);

/* The five warp threads, in the exact five hues --gradient-thread stops on —
   the ribbon literalized as individual strands rather than a fill. Threads
   at index 0, 2, 4 are drawn whole, on top of the weft; 1 and 3 are drawn as
   two short segments with a gap at the crossing, so the weft reads as
   passing in front of them there. That alternation is what makes it a weave
   rather than a row of threads with a line through them. */
const WARP = [
  { x: 10, color: "#a960ee", over: true },
  { x: 42, color: "#ff333d", over: false },
  { x: 74, color: "#ff8a00", over: true },
  { x: 106, color: "#90e0ff", over: false },
  { x: 138, color: "#ffcb57", over: true },
];
const WEFT_Y = 10;
const GAP = 5;

/* The dictionary epigraph, in the serif editorial voice. The entry is the one
   from lib/constants.ts, verbatim — the metaphor is the pitch. Beneath it,
   an actual small weave rather than a flat gradient bar: the weft thread
   draws itself left to right, once, as the epigraph enters view, passing
   over and under the five warp threads in the ribbon's own colors — the
   single most literal place on the page to animate the metaphor the copy
   above it states outright. Reduced motion shows it fully drawn, still. */
export default function Definition() {
  const weftRef = useRef<SVGPathElement>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (reduce || !weftRef.current) return;
    const ctx = gsap.context(() => {
      gsap.fromTo(
        weftRef.current,
        { strokeDashoffset: 1 },
        {
          strokeDashoffset: 0,
          duration: 0.8,
          ease: "power2.out",
          scrollTrigger: {
            trigger: weftRef.current,
            start: "top 85%",
            toggleActions: "play none none none",
          },
        },
      );
    });
    return () => ctx.revert();
  }, [reduce]);

  return (
    <section
      style={{
        maxWidth: "var(--maxw-narrow)",
        margin: "0 auto",
        padding: "var(--section-y-sm) 24px",
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-serif)",
          fontSize: 34,
          color: "var(--text-strong)",
        }}
      >
        {definition.word}{" "}
        <span style={{ color: "var(--text-subtle)", fontSize: 24 }}>
          {definition.pronunciation}
        </span>{" "}
        <em style={{ fontSize: 24 }}>{definition.partOfSpeech}</em>
      </div>
      <p
        style={{
          fontFamily: "var(--font-serif)",
          fontSize: 21,
          fontStyle: "italic",
          color: "var(--text-body)",
          lineHeight: 1.6,
          margin: "12px 0 0",
        }}
      >
        {definition.body}
      </p>
      <svg
        width={148}
        height={20}
        viewBox="0 0 148 20"
        style={{ margin: "26px auto 0", display: "block" }}
        aria-hidden="true"
      >
        <path
          ref={weftRef}
          d={`M 0 ${WEFT_Y} Q 37 ${WEFT_Y - 4}, 74 ${WEFT_Y} T 148 ${WEFT_Y}`}
          fill="none"
          stroke="var(--text-subtle)"
          strokeWidth={1.5}
          strokeLinecap="round"
          pathLength={1}
          strokeDasharray="1 1"
          strokeDashoffset={reduce ? 0 : 1}
        />
        {WARP.filter((w) => !w.over).map((w) => (
          <g key={w.x} stroke={w.color} strokeWidth={3} strokeLinecap="round">
            <line x1={w.x} y1={2} x2={w.x} y2={WEFT_Y - GAP} />
            <line x1={w.x} y1={WEFT_Y + GAP} x2={w.x} y2={18} />
          </g>
        ))}
        {WARP.filter((w) => w.over).map((w) => (
          <line
            key={w.x}
            x1={w.x}
            y1={2}
            x2={w.x}
            y2={18}
            stroke={w.color}
            strokeWidth={3}
            strokeLinecap="round"
          />
        ))}
      </svg>
    </section>
  );
}
