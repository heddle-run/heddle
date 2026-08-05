/* The paper's own grain — a fixed, pointer-events-none noise field over the
   whole viewport, inlined as an SVG filter so there is no request and no
   flash. Alpha-composited at low opacity rather than blended, since a
   mix-blend-mode multiplies against the base colour and does nothing over
   the dark theme's pure black. */
const NOISE = encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='140' height='140'>
    <filter id='n'>
      <feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/>
      <feColorMatrix type='saturate' values='0'/>
    </filter>
    <rect width='100%' height='100%' filter='url(#n)'/>
  </svg>`,
);

export default function Grain() {
  return (
    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 999,
        pointerEvents: "none",
        opacity: 0.05,
        backgroundImage: `url("data:image/svg+xml,${NOISE}")`,
      }}
    />
  );
}
