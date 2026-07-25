import Container from "./ui/Container";
import Label from "./ui/Label";
import { specimenSpread } from "@/lib/constants";

/* Terminal lines carry no colour — only weight and opacity. */
const lineTone: Record<string, string> = {
  prompt: "text-paper",
  cont: "text-paper/70",
  muted: "text-paper/40",
  step: "text-paper",
  tool: "text-paper/60",
  out: "text-paper/85",
  blank: "text-paper/40",
};

export default function Spread() {
  return (
    <section className="relative overflow-hidden">
      <Container className="relative py-24 md:py-32">
        <div className="flex items-center gap-6">
          <Label>005 — In practice</Label>
          <span aria-hidden className="h-px flex-1 bg-hairline" />
        </div>

        <h2 className="mt-6 max-w-[24ch] font-display text-4xl leading-[1.02] tracking-tight md:text-5xl">
          The document on the left.
          <br />
          <span className="italic">The run on the right.</span>
        </h2>

        <div className="mt-16 grid border border-ink lg:grid-cols-2">
          <div className="min-w-0 border-b border-ink lg:border-r lg:border-b-0">
            <p className="border-b border-hairline px-6 py-4 font-mono text-[0.625rem] uppercase tracking-[0.2em] text-muted-ink">
              flow.yaml
            </p>
            <pre className="overflow-x-auto px-6 py-8 font-mono text-xs leading-relaxed">
              <code>{specimenSpread.spec}</code>
            </pre>
          </div>

          <div className="min-w-0 bg-ink text-paper">
            <p className="border-b border-paper/25 px-6 py-4 font-mono text-[0.625rem] uppercase tracking-[0.2em] text-paper/50">
              stdout
            </p>
            <pre className="overflow-x-auto px-6 py-8 font-mono text-xs leading-relaxed">
              <code>
                {specimenSpread.terminal.map((line, i) => (
                  <span key={i} className={`block ${lineTone[line.kind]}`}>
                    {line.kind === "prompt" ? (
                      <>
                        <span className="text-paper/40">$ </span>
                        {line.text}
                      </>
                    ) : (
                      line.text || " "
                    )}
                  </span>
                ))}
              </code>
            </pre>
          </div>
        </div>
      </Container>
    </section>
  );
}
