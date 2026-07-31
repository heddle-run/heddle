import { BoxedFrame, Icon } from "@/ds";
import SectionLabel from "./SectionLabel";
import { COMPARE_URL } from "@/lib/constants";

export default function Manifesto() {
  return (
    <section className="hd-section">
      <div className="hd-container">
        <SectionLabel index="001">Position</SectionLabel>

        <BoxedFrame corners="diagonal" edges="horizontal" pad="var(--space-8)">
          <div className="hd-split" style={{ alignItems: "start" }}>
            <h2
              style={{
                margin: 0,
                fontSize: "clamp(30px,4vw,48px)",
                fontWeight: "var(--fw-semibold)",
                letterSpacing: "var(--tracking-tight)",
                lineHeight: "var(--lh-snug)",
                color: "var(--text-strong)",
              }}
            >
              Orchestration is not a library problem.
            </h2>

            <div>
              <p
                style={{
                  margin: 0,
                  fontSize: "var(--fs-lg)",
                  lineHeight: "var(--lh-relaxed)",
                  color: "var(--text-body)",
                }}
              >
                Most agent frameworks ship as an SDK. You install the library
                and adopt its abstractions before you can express your own — a
                class to subclass, a decorator to remember, a runtime to keep
                alive — and what you end up with is code that depends on them.
                heddle takes the opposite position. The specification is the
                program. A flow is a document: nodes, control-flow edges,
                data-flow edges. heddle is the small, unexciting machine that
                reads that document, proves it well-formed, and executes it in
                order.
              </p>

              <p
                style={{
                  margin: "var(--space-6) 0 0",
                  fontSize: "var(--fs-base)",
                  lineHeight: "var(--lh-relaxed)",
                  color: "var(--text-muted)",
                }}
              >
                Everything else stays where it already lives. Tools are
                executables on disk. Models are endpoints you already pay for.
                State is a plain object handed from one node to the next, never
                mutated in place. Nothing is hidden behind a service, so nothing
                has to be trusted on faith — and a flow that runs here runs on
                any other conforming runtime unchanged.
              </p>

              <a
                href={COMPARE_URL}
                className="ff-text-transition"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "var(--space-2)",
                  marginTop: "var(--space-6)",
                  fontSize: "var(--fs-sm)",
                  fontWeight: "var(--fw-medium)",
                  color: "var(--text-strong)",
                }}
              >
                The same agent, four frameworks
                <Icon name="arrow-right" size={14} />
              </a>
            </div>
          </div>
        </BoxedFrame>
      </div>
    </section>
  );
}
