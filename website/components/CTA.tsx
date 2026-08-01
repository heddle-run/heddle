import Link from "next/link";
import { BoxedFrame, Button, Badge } from "@/ds";
import InstallTabs from "./InstallTabs";
import { GITHUB_URL } from "@/lib/constants";

export default function CTA() {
  return (
    <section id="start" className="hd-section" style={{ scrollMarginTop: 80 }}>
      <div className="hd-container">
        <BoxedFrame beam pad="var(--space-16)">
          <div style={{ textAlign: "center" }}>
            <Badge uppercase>Thread the loom</Badge>

            <h2
              style={{
                margin: "var(--space-6) auto 0",
                maxWidth: "16ch",
                fontSize: "clamp(36px,5vw,72px)",
                fontWeight: "var(--fw-medium)",
                letterSpacing: "var(--tracking-tighter)",
                lineHeight: "var(--lh-tight)",
                color: "var(--text-strong)",
              }}
            >
              Zero to agent in one command.
            </h2>

            <InstallTabs />

            <div
              style={{
                marginTop: "var(--space-8)",
                display: "flex",
                flexWrap: "wrap",
                justifyContent: "center",
                gap: "var(--space-4)",
              }}
            >
              <Link href="/docs">
                <Button size="lg" iconAfter="arrow-right">
                  Get started
                </Button>
              </Link>
              <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
                <Button size="lg" variant="ghost" icon="github">
                  Read the source
                </Button>
              </a>
            </div>
          </div>
        </BoxedFrame>
      </div>
    </section>
  );
}
