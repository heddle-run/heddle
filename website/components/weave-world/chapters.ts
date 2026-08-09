/* The world-state ledger, one keyframe per section boundary, in the exact
   order app/page.tsx renders them: Hero, Inventory, Position, Method,
   Runtimes, Isolation, Definition, FAQ, CTA. Copy and claims stay in
   lib/constants.ts — this file only describes the loom behind them.

   The loom is a three-thread ply on a fixed orthographic frame (see
   threadField.ts), so the knobs are the braid's, not a camera's:

   - `drift` advances the braid's twist as the page scrolls — the world
     turns rather than travels.
   - `shed` opens the ply: 0 is the closed braid, 1 separates the three
     strands wide enough for the weft to pass through the gap. Position and
     CTA — the two dark-band chapters — are where it opens, because that is
     the loom action the brand is named for.
   - `weft` reveals the crossing thread left-to-right; it completes at
     Definition (the close-up payoff) and again over the CTA.
   - `glow` lifts the threads on the dark bands, where they carry the image.

   Keyframe i is the world at the TOP of section i; a tenth entry is the
   page bottom. Fields interpolate linearly, except the background: each
   section holds its surface through its middle and crosses to the next only
   inside a narrow band around the boundary. The canvas is the page ground,
   so palette() must follow the theme toggle — the same values colors.css
   gives --surface-page and --surface-code, hardcoded here because a WebGL
   clear colour cannot read a CSS variable; change them together. */

/* The light page ground is a soft vertical gradient of warm ivory —
   lighter tints of #F7F4ED, matching the site-layer --surface-page
   override in app/globals.css; keep the two in the same family. The dark
   theme stays flat black with the near-black band. */
export function palette(dark: boolean) {
  return dark
    ? { pageTop: "#000000", pageBottom: "#000000", band: "#0f0f0f" }
    : { pageTop: "#fefdfa", pageBottom: "#f7f4ed", band: "#081b2c" };
}

type Key = {
  band: boolean; /* dark band chapter (canvas goes navy / near-black) */
  drift: number;
  shed: number;
  weft: number;
  glow: number;
};

export const KEYFRAMES: Key[] = [
  /* 0 hero        */ { band: false, drift: 0.0, shed: 0.1, weft: 0.0, glow: 0.25 },
  /* 1 inventory   */ { band: false, drift: 0.9, shed: 0.08, weft: 0.0, glow: 0.1 },
  /* 2 position    */ { band: true, drift: 1.8, shed: 0.85, weft: 0.55, glow: 0.8 },
  /* 3 method      */ { band: false, drift: 2.7, shed: 0.18, weft: 0.0, glow: 0.15 },
  /* 4 runtimes    */ { band: false, drift: 3.4, shed: 0.3, weft: 0.0, glow: 0.2 },
  /* 5 isolation   */ { band: false, drift: 4.1, shed: 0.04, weft: 0.0, glow: 0.12 },
  /* 6 definition  */ { band: false, drift: 4.8, shed: 0.5, weft: 0.9, glow: 0.35 },
  /* 7 faq         */ { band: false, drift: 5.2, shed: 0.1, weft: 0.9, glow: 0.1 },
  /* 8 cta         */ { band: true, drift: 5.9, shed: 1.0, weft: 0.2, glow: 1.0 },
  /* 9 page bottom */ { band: true, drift: 6.2, shed: 1.0, weft: 1.0, glow: 1.0 },
];

export type SampledWorld = {
  /* 0 = page surface, 1 = dark band surface, crossed near boundaries only */
  bandMix: number;
  drift: number;
  shed: number;
  weft: number;
  glow: number;
};

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
};

export function sampleWorld(progress: number): SampledWorld {
  const n = KEYFRAMES.length;
  const clamped = Math.min(Math.max(progress, 0), n - 1 - 1e-6);
  const index = Math.floor(clamped);
  const t = clamped - index;
  const a = KEYFRAMES[index];
  const b = KEYFRAMES[Math.min(index + 1, n - 1)];
  const lerp = (x: number, y: number) => x + (y - x) * t;

  /* Background: hold a's surface until the last fifth of the section, then
     cross into b's. The crossing lands at the boundary, where the sections
     leave breathing room, so copy never sits on a half-faded ground. */
  const cross = smoothstep(0.8, 1.0, t);
  const bandMix = (a.band ? 1 - cross : 0) + (b.band ? cross : 0);

  return {
    bandMix,
    drift: lerp(a.drift, b.drift),
    shed: lerp(a.shed, b.shed),
    weft: lerp(a.weft, b.weft),
    glow: lerp(a.glow, b.glow),
  };
}
