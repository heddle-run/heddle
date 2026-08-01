import { BoxedFrame, Icon } from "@/ds";
import SectionLabel from "./SectionLabel";
import { COMPARE_URL } from "@/lib/constants";

export default function Manifesto() {
  return (
    <section className="hd-section">
      <div className="hd-container">
        <SectionLabel index="002">Position</SectionLabel>

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
              Batteries included usually means a bigger library.
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
                It is a good promise with an awkward bill. When a framework
                ships the sandbox, the server and the retry policy, it ships
                them <em>into your project</em> — so the more complete it gets,
                the more of it you import, pin, upgrade and eventually work
                around. Completeness and weight arrive together, and you pay for
                the batteries whether or not you use them. heddle refuses the
                trade. The specification is the program: a flow is a document of
                nodes, control-flow edges and data-flow edges. heddle is the
                machine that reads that document, proves it well-formed, and
                executes it in order.
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
                has to be trusted on faith — and because the document conforms
                to a published specification rather than to this project, a flow
                that runs here runs on any other conforming runtime unchanged.
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
