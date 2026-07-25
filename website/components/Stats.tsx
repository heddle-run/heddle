import Container from "./ui/Container";
import Texture from "./ui/Texture";
import { stats } from "@/lib/constants";

/** The one inverted band in the upper half of the page. */
export default function Stats() {
  return (
    <section className="relative overflow-hidden bg-ink text-paper">
      <Texture variant="warp-inverted" />

      <Container className="relative py-20 md:py-24">
        <dl className="grid grid-cols-2 md:grid-cols-4">
          {stats.map((stat, i) => (
            <div
              key={stat.label}
              className={`px-2 py-6 md:px-8 ${
                i > 0 ? "md:border-l md:border-paper/25" : ""
              } ${i % 2 === 1 ? "border-l border-paper/25 md:border-l" : ""}`}
            >
              <dt className="font-mono text-[0.625rem] uppercase tracking-[0.2em] text-paper/50">
                {stat.label}
              </dt>
              <dd className="mt-3 font-display text-6xl leading-none tracking-tighter md:text-7xl">
                {stat.value}
              </dd>
            </div>
          ))}
        </dl>
      </Container>
    </section>
  );
}
