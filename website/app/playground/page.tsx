import type { Metadata } from "next";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import Container from "@/components/ui/Container";
import Label from "@/components/ui/Label";
import Texture from "@/components/ui/Texture";
import Rule from "@/components/ui/Rule";
import Playground from "@/components/playground/Playground";

export const metadata: Metadata = {
  title: "Playground",
  description:
    "Write an Agent Spec flow, wire tools and plugins, and run it in the browser against a live heddle engine.",
};

export default function PlaygroundPage() {
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      <Nav />

      <main id="main">
        <section className="relative overflow-hidden">
          <Texture variant="warp" />
          <Container className="relative py-20 md:py-24">
            <div className="flex items-center gap-6">
              <Label>007 — Playground</Label>
              <span aria-hidden className="h-px flex-1 bg-hairline" />
            </div>

            <h1 className="mt-8 max-w-[16ch] font-display text-6xl leading-[0.95] tracking-tight md:text-7xl">
              Run it <span className="italic">here</span>.
            </h1>

            <p className="mt-8 max-w-[54ch] text-lg leading-relaxed text-muted-ink">
              A flow, its inputs, the tools it calls and the plugins that extend
              it — all editable, all executed by the same engine the CLI drives.
              Events stream back as the run happens.
            </p>

            <p className="mt-6 max-w-[54ch] font-mono text-xs leading-loose text-muted-ink">
              Tools and plugins you submit run in their own sandboxed processes
              and are deleted when the run ends. Nothing is stored. An API key
              in your flow does travel to the engine to reach the model — use a
              key you are willing to spend, and revoke it when you are done.
            </p>
          </Container>
        </section>

        <Rule />

        <Playground />

        <Rule />

        <section className="relative overflow-hidden">
          <Texture variant="lines" />
          <Container className="relative py-20 md:py-24">
            <div className="flex items-center gap-6">
              <Label>008 — The same thing, locally</Label>
              <span aria-hidden className="h-px flex-1 bg-hairline" />
            </div>

            <h2 className="mt-6 max-w-[24ch] font-display text-4xl leading-[1.02] tracking-tight md:text-5xl">
              Nothing here is browser-only.
            </h2>

            <p className="mt-8 max-w-[58ch] text-lg leading-relaxed text-muted-ink">
              The playground has no privileges the CLI lacks. Save the flow to a
              file, put the tools in a directory, and the same run happens on
              your own machine — with your own keys, and without the limits this
              page runs under.
            </p>

            <pre className="mt-10 overflow-x-auto border border-ink px-6 py-5 font-mono text-xs leading-loose">
              <code>{`brew install spichen/tap/heddle
heddle run flow.yaml --tools-dir ./tools --input '{"text":"hello"}'`}</code>
            </pre>
          </Container>
        </section>
      </main>

      <Footer />
    </>
  );
}
