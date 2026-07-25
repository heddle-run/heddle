import Container from "./ui/Container";
import Label from "./ui/Label";
import { faqItems } from "@/lib/constants";

/*
 * Native <details> elements: keyboard-accessible, no JavaScript, and the state
 * change is instant — which is exactly the motion this system asks for.
 */
export default function FAQ() {
  return (
    <section className="relative overflow-hidden">
      <Container className="relative py-24 md:py-32">
        <div className="grid gap-12 md:grid-cols-12">
          <div className="md:col-span-4">
            <Label>006 — Questions</Label>
            <h2 className="mt-6 font-display text-4xl leading-[1.02] tracking-tight md:text-5xl">
              Asked
              <br />
              <span className="italic">and answered.</span>
            </h2>
          </div>

          <dl className="border-t border-ink md:col-span-8">
            {faqItems.map((item) => (
              <div key={item.question} className="border-b border-ink">
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-start justify-between gap-6 py-6 focus-visible:outline focus-visible:outline-[3px] focus-visible:-outline-offset-[3px] focus-visible:outline-ink [&::-webkit-details-marker]:hidden">
                    <dt className="font-display text-xl leading-snug tracking-tight md:text-2xl">
                      {item.question}
                    </dt>
                    <span
                      aria-hidden
                      className="relative mt-2 h-3.5 w-3.5 shrink-0"
                    >
                      <span className="absolute top-1/2 left-0 h-px w-full -translate-y-1/2 bg-ink" />
                      <span className="absolute top-0 left-1/2 h-full w-px -translate-x-1/2 bg-ink group-open:hidden" />
                    </span>
                  </summary>
                  <dd className="max-w-[62ch] pb-8 text-lg leading-relaxed text-muted-ink">
                    {item.answer}
                  </dd>
                </details>
              </div>
            ))}
          </dl>
        </div>
      </Container>
    </section>
  );
}
