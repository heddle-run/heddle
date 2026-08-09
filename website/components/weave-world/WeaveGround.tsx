"use client";

/* Drop-in replacement for the old fixed <WeaveTexture variant="faint">
   layer in app/layout.tsx. The SVG texture still renders, unconditionally,
   one z-index further back — it's the real fallback for no-JS, no-WebGL,
   and prefers-reduced-motion, not just a loading placeholder, so removing
   or breaking WeaveWorld can never take the page's ground below "the
   design that already shipped." WeaveWorld is dynamically imported with
   ssr:false because it touches canvas/WebGL, which don't exist on the
   server. */

import dynamic from "next/dynamic";
import { WeaveTexture } from "@/components/WeaveTexture";

const WeaveWorld = dynamic(() => import("./WeaveWorld"), { ssr: false });

export function WeaveGround() {
  return (
    <>
      <WeaveTexture variant="faint" style={{ position: "fixed", zIndex: -2 }} />
      <WeaveWorld />
    </>
  );
}
