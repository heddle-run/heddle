import { cn } from "@/lib/cn";

/*
 * The loom figure: nine warp threads under tension, lifted in alternation by
 * four heddle frames, converging into a single woven output. It doubles as the
 * execution pipeline — parse, validate, compile, run — so the brand mark and
 * the architecture diagram are the same drawing.
 */

const THREADS = 9;
const SPACING = 30;
const TOP = 40;
const STATIONS = [180, 420, 660, 900];
const LIFT = 14;
const CENTER = TOP + ((THREADS - 1) / 2) * SPACING; // 160
const CONVERGE_X = 1000;
const END_X = 1148;

const stages = ["Parse", "Validate", "Compile", "Run"];

function threadPath(index: number): string {
  const y = TOP + index * SPACING;
  const points: string[] = [`M 0 ${y}`];

  STATIONS.forEach((x, station) => {
    // Alternating lift pattern — the shed opens differently at each frame.
    const lifted = (index + station) % 2 === 0;
    const eyeY = lifted ? y - LIFT : y + LIFT;
    points.push(`L ${x - 36} ${y}`, `L ${x} ${eyeY}`, `L ${x + 36} ${y}`);
  });

  points.push(`L ${CONVERGE_X} ${y}`, `L ${END_X} ${CENTER}`);
  return points.join(" ");
}

export default function Loom({ className }: { className?: string }) {
  const threads = Array.from({ length: THREADS }, (_, i) => i);
  const active = Math.floor(THREADS / 2);

  return (
    <div className={cn("w-full", className)}>
      <svg
        viewBox="0 0 1200 340"
        role="img"
        aria-labelledby="loom-title loom-desc"
        className="w-full"
        fill="none"
      >
        <title id="loom-title">The heddle execution pipeline</title>
        <desc id="loom-desc">
          Nine warp threads pass through four heddle frames — parse, validate,
          compile and run — and converge into a single output.
        </desc>

        {/* Heddle frames */}
        {STATIONS.map((x) => (
          <g key={x}>
            <line
              x1={x}
              y1={12}
              x2={x}
              y2={308}
              stroke="currentColor"
              strokeWidth={1}
              opacity={0.35}
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

        {/* Warp threads */}
        {threads.map((i) => (
          <path
            key={i}
            d={threadPath(i)}
            stroke="currentColor"
            strokeWidth={i === active ? 2 : 1}
            opacity={i === active ? 1 : 0.4}
          />
        ))}

        {/* Heddle eyes — the point where a thread is picked up */}
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
                fill="var(--color-paper)"
                stroke="currentColor"
                strokeWidth={i === active ? 2 : 1}
                opacity={i === active ? 1 : 0.45}
              />
            );
          }),
        )}

        {/* The cloth */}
        <rect x={END_X} y={CENTER - 9} width={18} height={18} fill="currentColor" />
      </svg>

      {/* Stage legend — kept in markup so it stays legible at every width */}
      <ol className="mt-8 grid grid-cols-2 border-t border-l border-ink sm:grid-cols-4">
        {stages.map((stage, i) => (
          <li
            key={stage}
            className="border-r border-b border-ink px-4 py-3 font-mono text-[0.625rem] uppercase tracking-[0.2em]"
          >
            <span className="text-muted-ink">{`0${i + 1} `}</span>
            {stage}
          </li>
        ))}
      </ol>
    </div>
  );
}
