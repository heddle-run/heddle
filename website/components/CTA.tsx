import { ArrowRight } from "lucide-react";
import Container from "./ui/Container";
import Texture from "./ui/Texture";
import Button from "./ui/Button";
import CopyCommand from "./CopyCommand";
import { GITHUB_URL, installCommands } from "@/lib/constants";

export default function CTA() {
  return (
    <section id="start" className="relative overflow-hidden bg-ink text-paper">
      <Texture variant="radial-inverted" />
      <Texture variant="warp-inverted" />

      <Container className="relative py-24 text-center md:py-36">
        <p className="font-mono text-[0.625rem] uppercase tracking-[0.3em] text-paper/50">
          Thread the loom
        </p>

        <h2 className="mx-auto mt-8 max-w-[14ch] font-display text-5xl leading-[0.95] tracking-tighter sm:text-7xl md:text-8xl">
          Zero to agent in one command.
        </h2>

        <div className="mx-auto mt-14 flex max-w-xl flex-col gap-3">
          {installCommands.map((c) => (
            <CopyCommand key={c.label} label={c.label} command={c.cmd} inverted />
          ))}
        </div>

        <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <Button href="/docs" variant="inverted">
            Get started
            <ArrowRight size={16} strokeWidth={1.5} />
          </Button>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="border-b border-transparent py-2 font-mono text-xs uppercase tracking-[0.2em] text-paper/70 transition-colors duration-100 hover:border-paper hover:text-paper focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-paper"
          >
            Read the source
          </a>
        </div>
      </Container>
    </section>
  );
}
