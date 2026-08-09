import LandingChrome from "@/components/landing/LandingChrome";
import Chapter from "@/components/landing/Chapter";
import Hero from "@/components/Hero";
import Inventory from "@/components/Inventory";
import Position from "@/components/Position";
import Method from "@/components/Method";
import Runtimes from "@/components/Runtimes";
import Isolation from "@/components/Isolation";
import Definition from "@/components/Definition";
import FAQ from "@/components/FAQ";
import CTA from "@/components/CTA";
import Footer from "@/components/Footer";

/* The landing page is one continuous walk through the loom world mounted in
   app/layout.tsx: nine full-viewport chapters over a single persistent
   Three.js scene, kage-style, with the fixed bar and chapter rail from
   LandingChrome instead of the shared sticky Nav (which still serves
   /library and the 404). Each Chapter's id is both the scroll conductor's
   anchor and the rail's target — the world's keyframes in
   weave-world/chapters.ts are ordered to match this exact sequence, so
   adding, removing or reordering a chapter means updating that ledger and
   the CHAPTERS list in LandingChrome together. Copy still lives in
   lib/constants.ts and the section components; nothing here invents
   content. */
export default function Home() {
  return (
    <div style={{ minHeight: "100vh" }}>
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      <LandingChrome />

      <main id="main" style={{ paddingTop: 60 }}>
        <Chapter id="start" surface="none">
          <Hero />
        </Chapter>
        <Chapter id="included">
          <Inventory />
        </Chapter>
        <Chapter id="position" surface="band">
          <Position />
        </Chapter>
        <Chapter id="method">
          <Method />
        </Chapter>
        <Chapter id="runtimes">
          <Runtimes />
        </Chapter>
        <Chapter id="isolation">
          <Isolation />
        </Chapter>
        <Chapter id="definition">
          <Definition />
        </Chapter>
        <Chapter id="faq">
          <FAQ />
        </Chapter>
        <Chapter id="begin" surface="band">
          <CTA />
        </Chapter>
      </main>

      {/* The footer closes the page on its own solid surface so the world
          ends at the last chapter rather than glowing on under the index. */}
      <div
        style={{
          position: "relative",
          zIndex: 1,
          background: "var(--surface-page)",
          borderTop: "1px solid var(--border-hairline)",
        }}
      >
        <Footer />
      </div>
    </div>
  );
}
