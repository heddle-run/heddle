/* The world-state ledger, one keyframe per section boundary, in the exact
   order app/page.tsx renders them: Hero, Inventory, Position, Method,
   Runtimes, Isolation, Definition, FAQ, CTA. Copy and claims stay in
   lib/constants.ts — this file only describes the loom behind them.

   Keyframe i is the world at the TOP of section i; a tenth entry is the
   page bottom. Most fields interpolate linearly between keyframes, but the
   background holds each section's colour through its middle and crosses to
   the next only inside a narrow band around the boundary — a section is
   *on* a surface, it doesn't spend its whole height fading to the next.
   Position (2) and CTA (8) are the two dark-band chapters: the canvas
   itself goes navy there (the sections no longer paint their own
   backgrounds), the shed opens wide, and the threads glow.

   The canvas is the page ground, so it must follow the theme toggle:
   `palette(dark)` swaps paper/navy for the dark theme's black/#0f0f0f —
   the same values colors.css gives --surface-page and --surface-code.
   Phase one hardcoded paper and painted the dark theme light; WeaveWorld
   now watches html.dark and passes the flag through. */

export const THREAD_HUES = [0xa960ee, 0xff333d, 0xff8a00, 0x90e0ff, 0xffcb57];

export function palette(dark: boolean) {
  return dark
    ? { page: "#000000", band: "#0f0f0f" }
    : { page: "#f6f9fc", band: "#081b2c" };
}

type Key = {
  band: boolean; /* dark band chapter (canvas goes navy / near-black) */
  key: number;
  ambient: number;
  emissive: number;
  fog: number;
  shed: number;
  weft: number;
  cameraZ: number;
  fov: number;
  fovMobile: number;
};

export const KEYFRAMES: Key[] = [
  /* 0 hero        */ { band: false, key: 1.0, ambient: 0.7, emissive: 0.25, fog: 0.02, shed: 0.1, weft: 0.0, cameraZ: 0, fov: 44, fovMobile: 54 },
  /* 1 inventory   */ { band: false, key: 0.9, ambient: 0.65, emissive: 0.1, fog: 0.028, shed: 0.1, weft: 0.0, cameraZ: 5, fov: 42, fovMobile: 52 },
  /* 2 position    */ { band: true, key: 0.35, ambient: 0.18, emissive: 0.8, fog: 0.02, shed: 0.55, weft: 0.55, cameraZ: 8, fov: 40, fovMobile: 50 },
  /* 3 method      */ { band: false, key: 0.95, ambient: 0.65, emissive: 0.15, fog: 0.025, shed: 0.2, weft: 0.0, cameraZ: 13, fov: 42, fovMobile: 52 },
  /* 4 runtimes    */ { band: false, key: 0.9, ambient: 0.6, emissive: 0.2, fog: 0.026, shed: 0.35, weft: 0.0, cameraZ: 17, fov: 42, fovMobile: 52 },
  /* 5 isolation   */ { band: false, key: 0.85, ambient: 0.6, emissive: 0.12, fog: 0.03, shed: 0.05, weft: 0.0, cameraZ: 21, fov: 41, fovMobile: 51 },
  /* 6 definition  */ { band: false, key: 1.05, ambient: 0.6, emissive: 0.35, fog: 0.018, shed: 0.45, weft: 0.9, cameraZ: 25, fov: 34, fovMobile: 44 },
  /* 7 faq         */ { band: false, key: 0.9, ambient: 0.62, emissive: 0.1, fog: 0.028, shed: 0.12, weft: 0.9, cameraZ: 27, fov: 40, fovMobile: 50 },
  /* 8 cta         */ { band: true, key: 0.35, ambient: 0.18, emissive: 1.0, fog: 0.02, shed: 0.8, weft: 0.2, cameraZ: 30, fov: 40, fovMobile: 50 },
  /* 9 page bottom */ { band: true, key: 0.35, ambient: 0.18, emissive: 1.0, fog: 0.02, shed: 0.8, weft: 1.0, cameraZ: 31, fov: 40, fovMobile: 50 },
];

export type SampledWorld = {
  /* 0 = page surface, 1 = dark band surface, crossed near boundaries only */
  bandMix: number;
  key: number;
  ambient: number;
  emissive: number;
  fog: number;
  shed: number;
  weft: number;
  cameraZ: number;
  fov: number;
  fovMobile: number;
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
     cross into b's. The crossing lands right at the boundary, where the
     sections leave breathing room, so copy never sits on a half-faded
     ground. */
  const cross = smoothstep(0.8, 1.0, t);
  const bandMix = (a.band ? 1 - cross : 0) + (b.band ? cross : 0);

  return {
    bandMix,
    key: lerp(a.key, b.key),
    ambient: lerp(a.ambient, b.ambient),
    emissive: lerp(a.emissive, b.emissive),
    fog: lerp(a.fog, b.fog),
    shed: lerp(a.shed, b.shed),
    weft: lerp(a.weft, b.weft),
    cameraZ: lerp(a.cameraZ, b.cameraZ),
    fov: lerp(a.fov, b.fov),
    fovMobile: lerp(a.fovMobile, b.fovMobile),
  };
}
