import Container from "./ui/Container";
import Texture from "./ui/Texture";
import Label from "./ui/Label";

export default function Manifesto() {
  return (
    <section className="relative overflow-hidden">
      <Texture variant="grid" />

      <Container className="relative py-24 md:py-32">
        <div className="grid gap-12 md:grid-cols-12">
          <div className="md:col-span-4">
            <Label>001 — Position</Label>
            <h2 className="mt-6 font-display text-3xl leading-[1.05] tracking-tight md:text-4xl">
              Orchestration is not
              <br />a library problem.
            </h2>
          </div>

          <div className="md:col-span-8 md:border-l md:border-hairline md:pl-12">
            <p className="drop-cap text-lg leading-relaxed">
              Most agent frameworks ask you to adopt their abstractions before
              you can express your own — a class to subclass, a decorator to
              remember, a runtime to keep alive. heddle takes the opposite
              position. The specification is the program. A flow is a document:
              nodes, control-flow edges, data-flow edges. heddle is the small,
              unexciting machine that reads that document, proves it
              well-formed, and executes it in order.
            </p>

            <p className="mt-6 text-lg leading-relaxed text-muted-ink">
              Everything else stays where it already lives. Tools are
              executables on disk. Models are endpoints you already pay for.
              State is a plain object handed from one node to the next, never
              mutated in place. Nothing is hidden behind a service, so nothing
              has to be trusted on faith — and a flow that runs here runs on any
              other conforming runtime unchanged.
            </p>
          </div>
        </div>
      </Container>
    </section>
  );
}
