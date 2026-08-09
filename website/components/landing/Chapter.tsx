import type { ReactNode } from "react";

/* One chapter of the landing page: a full-viewport stage over the loom
   world. The conductor counts direct <section> children of #main, and the
   rail's anchors point at these ids, so this wrapper owns both — the
   section components inside render plain <div> roots.

   `surface` controls the readability scrim: a full-width vertical gradient
   band in the chapter's own surface colour, fading at top and bottom so
   the world shows between chapters. Never an oval patch behind the copy —
   that was tried and it read as a floating blob in a real browser. "band"
   chapters (Position, CTA) sit where the canvas itself has gone navy, so
   their scrim mixes from --surface-code instead of the page surface;
   "none" is for the hero, whose copy owns its own local scrim. */
export default function Chapter({
  id,
  surface = "page",
  children,
}: {
  id: string;
  surface?: "page" | "band" | "none";
  children: ReactNode;
}) {
  const scrimColor =
    surface === "none"
      ? null
      : surface === "band"
        ? "color-mix(in srgb, var(--surface-code) 76%, transparent)"
        : "color-mix(in srgb, var(--surface-page) 72%, transparent)";

  return (
    <section
      id={id}
      style={{
        position: "relative",
        minHeight: "100svh",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        /* surface="none" is the hero, which sizes and centres its own
           viewport — wrapper padding on top of that double-stacks past
           100svh and opens a dead band above the content. */
        padding: surface === "none" ? 0 : "clamp(48px, 8vh, 96px) 0",
        scrollMarginTop: 60,
      }}
    >
      {scrimColor && (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            background: `linear-gradient(180deg, transparent 0%, ${scrimColor} 14%, ${scrimColor} 86%, transparent 100%)`,
          }}
        />
      )}
      <div style={{ position: "relative", width: "100%" }}>{children}</div>
    </section>
  );
}
