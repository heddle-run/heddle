import Container from "./ui/Container";
import Label from "./ui/Label";
import { specimens } from "@/lib/constants";

/** A plate of sample flows, set like figures in a catalogue. */
export default function Specimens() {
  return (
    <section id="specimens" className="relative scroll-mt-20 overflow-hidden">
      <Container className="relative py-24 md:py-32">
        <div className="flex items-center gap-6">
          <Label>004 — Specimens</Label>
          <span aria-hidden className="h-px flex-1 bg-hairline" />
        </div>

        <h2 className="mt-6 max-w-[22ch] font-display text-4xl leading-[1.02] tracking-tight md:text-5xl">
          Four flows, in full.
        </h2>

        <ul className="mt-16 grid border-t border-l border-ink md:grid-cols-2">
          {specimens.map((item) => (
            <li
              key={item.title}
              className="group flex min-w-0 flex-col border-r border-b border-ink bg-paper transition-colors duration-100 hover:bg-ink hover:text-paper"
            >
              <div className="flex items-baseline justify-between gap-4 border-b border-hairline px-8 py-5 transition-colors duration-100 group-hover:border-paper/25">
                <div>
                  <h3 className="font-display text-2xl leading-none tracking-tight">
                    {item.title}
                  </h3>
                  <p className="mt-2 text-sm text-muted-ink transition-colors duration-100 group-hover:text-paper/60">
                    {item.description}
                  </p>
                </div>
                <span className="font-display text-xl italic text-muted-ink transition-colors duration-100 group-hover:text-paper/60">
                  {item.index}
                </span>
              </div>

              <pre className="flex-1 overflow-x-auto px-8 py-6 font-mono text-xs leading-relaxed text-muted-ink transition-colors duration-100 group-hover:text-paper/75">
                <code>{item.code}</code>
              </pre>

              <p className="border-t border-hairline px-8 py-4 font-mono text-[0.625rem] uppercase tracking-[0.2em] text-muted-ink transition-colors duration-100 group-hover:border-paper/25 group-hover:text-paper/60">
                {item.category}
              </p>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}
