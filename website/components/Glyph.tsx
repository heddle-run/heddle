/**
 * The glyphs the site needs and the vendored Heddle `Icon` does not carry.
 *
 * `ds-heddle/components/core/Icon.jsx` is a faithful copy of upstream and takes
 * no site additions, but its eleven paths were drawn for a marketing page — the
 * playground needs run controls, a file tree and a theme switch. These are
 * lucide paths on the same 24 grid, at the same 1.5px round-capped stroke, so
 * the two sets are indistinguishable beside each other. Reach for `Icon` first;
 * only what it lacks belongs here.
 */

const PATHS = {
  braces: [
    "M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1",
    "M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1",
  ],
  columns: [
    "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
    "M12 3v18",
  ],
  play: ["M7 4.5v15l12-7.5z"],
  stop: ["M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"],
  checkCheck: ["M18 6 7 17l-5-5", "m22 10-7.5 7.5L13 16"],
  rotateCcw: [
    "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8",
    "M3 3v5h5",
  ],
  plus: ["M5 12h14", "M12 5v14"],
  arrowUpRight: ["M7 7h10v10", "M7 17 17 7"],
  scrollText: [
    "M15 12h-5",
    "M15 8h-5",
    "M19 17V5a2 2 0 0 0-2-2H4",
    "M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3",
  ],
  fileCode: [
    "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z",
    "M14 2v5h5",
    "m10 13-2 2 2 2",
    "m14 13 2 2-2 2",
  ],
  sun: [
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
    "M12 2v2",
    "M12 20v2",
    "m4.93 4.93 1.41 1.41",
    "m17.66 17.66 1.41 1.41",
    "M2 12h2",
    "M20 12h2",
    "m6.34 17.66-1.41 1.41",
    "m19.07 4.93-1.41 1.41",
  ],
  moon: ["M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"],
} as const;

export type GlyphName = keyof typeof PATHS;

export default function Glyph({
  name,
  size = 16,
  strokeWidth = 1.5,
}: {
  name: GlyphName;
  size?: number;
  strokeWidth?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: "0 0 auto" }}
      aria-hidden="true"
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
