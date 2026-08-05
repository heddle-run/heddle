"use client";

import { motion, useReducedMotion } from "motion/react";
import type { CSSProperties, ReactNode } from "react";

/* Fast and dry, per BRAND.md's Motion section: a fade and a small upward
   translate, staggered by index, never a bounce. Used for the sequential
   sections (Inventory, Method, Isolation) so each numbered item arrives in
   the order the reader reads it, once, rather than mounting all at once.
   prefers-reduced-motion skips straight to the settled state. */
export function Reveal({
  children,
  index = 0,
  y = 14,
  className,
  style,
}: {
  children: ReactNode;
  index?: number;
  y?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      style={style}
      initial={reduce ? false : { opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{
        duration: 0.5,
        delay: index * 0.05,
        ease: [0.2, 0, 0.2, 1],
      }}
    >
      {children}
    </motion.div>
  );
}
