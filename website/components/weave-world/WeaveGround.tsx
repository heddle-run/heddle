"use client";

/* The landing page's mount point for the loom world, rendered by
   app/page.tsx only — the world once lived in app/layout.tsx and drew its
   braid behind the docs' body text too. The site-wide ground stays the
   fixed faint WeaveTexture in the layout, one z-index behind the canvas;
   it is the real fallback for no-JS, no-WebGL and prefers-reduced-motion,
   and it is what every non-landing route shows. WeaveWorld is dynamically
   imported with ssr:false because it touches canvas/WebGL, which don't
   exist on the server. */

import dynamic from "next/dynamic";

const WeaveWorld = dynamic(() => import("./WeaveWorld"), { ssr: false });

export function WeaveGround() {
  return <WeaveWorld />;
}
