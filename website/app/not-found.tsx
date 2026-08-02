import Link from "next/link";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { Button, Icon } from "@/ds-heddle";

export default function NotFound() {
  return (
    <div className="hds" style={{ minHeight: "100vh" }}>
      <Nav />

      <main>
        <div
          className="hds-container"
          style={{
            paddingTop: "var(--section-y)",
            paddingBottom: "var(--section-y)",
            textAlign: "center",
          }}
        >
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              letterSpacing: "var(--ls-label)",
              textTransform: "uppercase",
              color: "var(--text-accent)",
            }}
          >
            Error — 404
          </div>

          <h1
            style={{
              margin: "20px auto 0",
              maxWidth: "14ch",
              fontSize: "clamp(44px, 7vw, 76px)",
              fontWeight: "var(--fw-light)",
              letterSpacing: "var(--ls-display)",
              lineHeight: "var(--lh-tight)",
              color: "var(--text-strong)",
            }}
          >
            Dropped a thread.
          </h1>

          <p
            style={{
              margin: "20px auto 0",
              maxWidth: "44ch",
              fontSize: "var(--fs-body-lg)",
              lineHeight: 1.6,
              color: "var(--text-muted)",
            }}
          >
            This page is not part of the weave. Head back to the front, or pick
            the pattern up in the documentation.
          </p>

          <div
            style={{
              marginTop: 32,
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "center",
              gap: 12,
            }}
          >
            <Button
              as="a"
              href="/"
              size="lg"
              iconRight={<Icon name="arrowRight" size={16} />}
            >
              Return home
            </Button>
            <Button as="a" href="/docs" size="lg" variant="secondary">
              Documentation
            </Button>
          </div>

          <div
            style={{
              width: 120,
              height: 2,
              background: "var(--gradient-thread)",
              margin: "44px auto 0",
            }}
          />
        </div>
      </main>

      <Footer />
    </div>
  );
}
