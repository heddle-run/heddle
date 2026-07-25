import Container from "./ui/Container";
import Texture from "./ui/Texture";
import { definition } from "@/lib/constants";

/** The epigraph: the name is the thesis, so the dictionary entry is the pull quote. */
export default function Definition() {
  return (
    <section className="relative overflow-hidden">
      <Texture variant="lines" />

      <Container className="relative py-24 md:py-32">
        <figure className="pull-quote mx-auto max-w-3xl text-center">
          <figcaption className="flex flex-wrap items-baseline justify-center gap-x-3 gap-y-1">
            <span className="font-display text-2xl tracking-tight">
              {definition.word}
            </span>
            <span className="font-mono text-xs text-muted-ink">
              {definition.pronunciation}
            </span>
            <span className="font-display text-lg italic text-muted-ink">
              {definition.partOfSpeech}
            </span>
          </figcaption>

          <blockquote className="mt-8 font-display text-2xl italic leading-[1.35] tracking-tight sm:text-3xl md:text-4xl md:leading-[1.25]">
            {definition.body}
          </blockquote>

          <div className="mt-12 flex items-center justify-center gap-4">
            <span aria-hidden className="h-px w-20 bg-ink" />
            <span aria-hidden className="h-2.5 w-2.5 border border-ink" />
            <span aria-hidden className="h-px w-20 bg-ink" />
          </div>
        </figure>
      </Container>
    </section>
  );
}
