import { ArrowRight } from "lucide-react";
import Container from "./ui/Container";
import Texture from "./ui/Texture";
import Label from "./ui/Label";
import Button from "./ui/Button";
import CopyCommand from "./CopyCommand";
import Loom from "./Loom";
import { AGENT_SPEC_URL, GITHUB_URL, installCommands } from "@/lib/constants";

const badges = ["Agent Spec compliant", "MIT licensed", "Runs locally"];

export default function Hero() {
  return (
    <section className="relative overflow-hidden">
      <Texture variant="warp" />
      <Texture variant="noise" />

      <Container className="relative pt-16 pb-20 md:pt-24 md:pb-28">
        <div className="flex items-center gap-6">
          <Label>Open Agent Specification</Label>
          <span aria-hidden className="h-px flex-1 bg-hairline" />
          <Label className="hidden sm:block">Est. 2026</Label>
        </div>

        <h1 className="mt-12">
          <span className="flex items-end gap-6">
            <span className="font-display text-[4.5rem] italic leading-[0.78] tracking-tighter sm:text-8xl lg:text-9xl">
              Weave
            </span>
            <span aria-hidden className="mb-5 h-px flex-1 bg-ink sm:mb-8" />
          </span>
          <span className="mt-3 block font-display text-4xl leading-[0.95] tracking-tight sm:text-5xl lg:text-6xl">
            agents from spec.
          </span>
        </h1>

        {/* Rule and punctuation square */}
        <div className="mt-12 flex items-center">
          <span aria-hidden className="h-1 flex-1 bg-ink" />
          <span aria-hidden className="ml-4 h-4 w-4 border-2 border-ink" />
        </div>

        <div className="mt-12 grid gap-14 md:grid-cols-12 md:gap-0">
          <div className="min-w-0 md:col-span-7 md:pr-12">
            <p className="max-w-[46ch] text-xl leading-relaxed text-muted-ink">
              heddle compiles a declarative{" "}
              <a
                href={AGENT_SPEC_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-ink underline decoration-1 underline-offset-4"
              >
                Agent Spec
              </a>{" "}
              into an executable graph — with the tool-calling loop, branching
              and any-language tools already in the box. No orchestration code.
              No server. One command.
            </p>

            <div className="mt-10 flex flex-col gap-4 sm:flex-row">
              <Button href="/docs">
                Read the docs
                <ArrowRight size={16} strokeWidth={1.5} />
              </Button>
              <Button href={GITHUB_URL} variant="secondary" external>
                View source
              </Button>
            </div>
          </div>

          <div className="min-w-0 md:col-span-5 md:border-l md:border-ink md:pl-12">
            <Label>Install</Label>
            <div className="mt-5 flex flex-col gap-3">
              {installCommands.map((c) => (
                <CopyCommand key={c.label} label={c.label} command={c.cmd} />
              ))}
            </div>

            <ul className="mt-8 flex flex-wrap gap-2">
              {badges.map((badge) => (
                <li
                  key={badge}
                  className="border border-hairline px-3 py-1.5 font-mono text-[0.625rem] uppercase tracking-[0.15em] text-muted-ink"
                >
                  {badge}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Container>

      {/* The loom band — pipeline and brand mark in one drawing */}
      <div className="relative border-t border-ink">
        <Texture variant="grid" />
        <Container className="relative py-14 md:py-20">
          <Loom />
        </Container>
      </div>
    </section>
  );
}
