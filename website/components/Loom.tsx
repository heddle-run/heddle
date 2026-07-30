const THREADS = 9;
const SPACING = 30;
const TOP = 40;
const STATIONS = [180, 420, 660, 900];
const LIFT = 14;
const CENTER = TOP + ((THREADS - 1) / 2) * SPACING;
const CONVERGE_X = 1000;
const END_X = 1148;

const stages = ["Parse", "Validate", "Compile", "Run"];

function threadPath(index: number): string {
  const y = TOP + index * SPACING;
  const points: string[] = [`M 0 ${y}`];

  STATIONS.forEach((x, station) => {
    const lifted = (index + station) % 2 === 0;
    const eyeY = lifted ? y - LIFT : y + LIFT;
    points.push(`L ${x - 36} ${y}`, `L ${x} ${eyeY}`, `L ${x + 36} ${y}`);
  });

  points.push(`L ${CONVERGE_X} ${y}`, `L ${END_X} ${CENTER}`);
  return points.join(" ");
}

export default function Loom() {
  const threads = Array.from({ length: THREADS }, (_, i) => i);
  const active = Math.floor(THREADS / 2);

  return (
    <div style={{ width: "100%" }}>
      <svg
        viewBox="0 0 1200 340"
        role="img"
        aria-labelledby="loom-title loom-desc"
        style={{ width: "100%", height: "auto", color: "var(--text-muted)" }}
        fill="none"
      >
        <title id="loom-title">The heddle execution pipeline</title>
        <desc id="loom-desc">
          Nine warp threads pass through four heddle frames — parse, validate,
          compile and run — and converge into a single output.
        </desc>

        {STATIONS.map((x) => (
          <g key={x}>
            <line
              x1={x}
              y1={12}
              x2={x}
              y2={308}
              stroke="currentColor"
              strokeWidth={1}
              opacity={0.7}
            />
            <rect
              x={x - 4}
              y={4}
              width={8}
              height={8}
              stroke="currentColor"
              strokeWidth={1}
            />
          </g>
        ))}

        {threads.map((i) => (
          <path
            key={i}
            d={threadPath(i)}
            stroke={i === active ? "var(--brand-pink)" : "currentColor"}
            strokeWidth={i === active ? 2 : 1}
            opacity={i === active ? 1 : 0.6}
          />
        ))}

        {threads.map((i) =>
          STATIONS.map((x, station) => {
            const y = TOP + i * SPACING;
            const lifted = (i + station) % 2 === 0;
            const eyeY = lifted ? y - LIFT : y + LIFT;
            return (
              <rect
                key={`${i}-${x}`}
                x={x - 5}
                y={eyeY - 5}
                width={10}
                height={10}
                rx={2}
                fill="var(--bg-page)"
                stroke={i === active ? "var(--brand-pink)" : "currentColor"}
                strokeWidth={i === active ? 2 : 1}
                opacity={i === active ? 1 : 0.5}
              />
            );
          }),
        )}

        <rect
          x={END_X}
          y={CENTER - 9}
          width={18}
          height={18}
          rx={3}
          fill="var(--brand-pink)"
        />
      </svg>

      <ol
        className="hd-grid hd-grid-4"
        style={{
          listStyle: "none",
          margin: "var(--space-8) 0 0",
          padding: 0,
          gap: "var(--space-3)",
        }}
      >
        {stages.map((stage, i) => (
          <li
            key={stage}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-3)",
              padding: "var(--space-3) var(--space-4)",
              border: "1px solid var(--border-default)",
              borderRadius: "var(--radius-lg)",
              background: "var(--surface-subtle)",
            }}
          >
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--fs-2xs)",
                fontWeight: "var(--fw-semibold)",
                color: "var(--brand-pink)",
              }}
            >
              {`0${i + 1}`}
            </span>
            <span
              style={{
                fontSize: "var(--fs-xs)",
                fontWeight: "var(--fw-medium)",
                textTransform: "uppercase",
                letterSpacing: "var(--tracking-widest)",
                color: "var(--text-body)",
              }}
            >
              {stage}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
