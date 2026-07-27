import Link from "next/link";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { Badge, BoxedFrame, Button } from "@/ds";

export default function NotFound() {
  return (
    <>
      <Nav />

      <main className="hd-section">
        <div className="hd-container">
          <BoxedFrame beam pad="var(--space-16)">
            <div style={{ textAlign: "center" }}>
              <Badge uppercase>Error — 404</Badge>

              <h1
                style={{
                  margin: "var(--space-6) auto 0",
                  maxWidth: "12ch",
                  fontSize: "clamp(48px,7vw,96px)",
                  fontWeight: "var(--fw-medium)",
                  letterSpacing: "var(--tracking-tighter)",
                  lineHeight: "var(--lh-tight)",
                  color: "var(--text-strong)",
                }}
              >
                Dropped a thread.
              </h1>

              <p
                style={{
                  margin: "var(--space-6) auto 0",
                  maxWidth: "var(--container-prose)",
                  fontSize: "var(--fs-lg)",
                  lineHeight: "var(--lh-relaxed)",
                  color: "var(--text-body)",
                }}
              >
                This page is not part of the weave. Head back to the front, or
                pick the pattern up in the documentation.
              </p>

              <div
                style={{
                  marginTop: "var(--space-10)",
                  display: "flex",
                  flexWrap: "wrap",
                  justifyContent: "center",
                  gap: "var(--space-4)",
                }}
              >
                <Link href="/">
                  <Button size="lg" iconAfter="arrow-right">
                    Return home
                  </Button>
                </Link>
                <Link href="/docs">
                  <Button size="lg" variant="outline">
                    Documentation
                  </Button>
                </Link>
              </div>
            </div>
          </BoxedFrame>
        </div>
      </main>

      <Footer />
    </>
  );
}
