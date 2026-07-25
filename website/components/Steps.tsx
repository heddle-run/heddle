import Container from "./ui/Container";
import Texture from "./ui/Texture";
import Label from "./ui/Label";
import { steps } from "@/lib/constants";

export default function Steps() {
  return (
    <section id="method" className="relative overflow-hidden scroll-mt-20">
      <Texture variant="diagonal" />

      <Container className="relative py-24 md:py-32">
        <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div>
            <Label>002 — Method</Label>
            <h2 className="mt-6 max-w-[16ch] font-display text-4xl leading-[1.02] tracking-tight md:text-5xl">
              Three moves, then it runs.
            </h2>
          </div>
          <p className="max-w-[38ch] text-lg leading-relaxed text-muted-ink">
            Declare the shape of the work. Hand it the tools. Pull the lever.
          </p>
        </div>

        <ol className="mt-16 grid border-t-2 border-l-2 border-ink md:grid-cols-3">
          {steps.map((step) => (
            <li
              key={step.number}
              className="group flex min-w-0 flex-col border-r-2 border-b-2 border-ink bg-paper p-8 transition-colors duration-100 hover:bg-ink hover:text-paper"
            >
              <div className="flex items-baseline gap-4">
                <span className="font-display text-5xl leading-none tracking-tighter">
                  {step.number}
                </span>
                <span className="font-mono text-xs uppercase tracking-[0.2em]">
                  {step.title}
                </span>
              </div>

              <p className="mt-6 text-base leading-relaxed text-muted-ink transition-colors duration-100 group-hover:text-paper/70">
                {step.description}
              </p>

              <pre className="mt-8 flex-1 overflow-x-auto border border-hairline p-4 font-mono text-[0.6875rem] leading-relaxed text-muted-ink transition-colors duration-100 group-hover:border-paper/30 group-hover:text-paper/70">
                <code>{step.code}</code>
              </pre>
            </li>
          ))}
        </ol>
      </Container>
    </section>
  );
}
