import Container from "./ui/Container";
import Texture from "./ui/Texture";
import Label from "./ui/Label";
import { features } from "@/lib/constants";

export default function Features() {
  return (
    <section className="relative overflow-hidden">
      <Texture variant="lines" />

      <Container className="relative py-24 md:py-32">
        <div className="flex items-center gap-6">
          <Label>003 — Apparatus</Label>
          <span aria-hidden className="h-px flex-1 bg-hairline" />
        </div>

        <h2 className="mt-6 max-w-[20ch] font-display text-4xl leading-[1.02] tracking-tight md:text-5xl">
          What comes in the box.
        </h2>

        <ul className="mt-16 grid border-t border-l border-ink sm:grid-cols-2 lg:grid-cols-3">
          {features.map(({ icon: Icon, title, description }) => (
            <li
              key={title}
              className="group border-r border-b border-ink bg-paper p-8 transition-colors duration-100 hover:bg-ink hover:text-paper"
            >
              <span className="flex h-11 w-11 items-center justify-center border border-ink transition-colors duration-100 group-hover:border-paper">
                <Icon size={20} strokeWidth={1.5} />
              </span>
              <h3 className="mt-6 font-display text-2xl leading-tight tracking-tight">
                {title}
              </h3>
              <p className="mt-3 text-base leading-relaxed text-muted-ink transition-colors duration-100 group-hover:text-paper/70">
                {description}
              </p>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}
