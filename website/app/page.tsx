import Nav from "@/components/Nav";
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

export default function Home() {
  return (
    <div style={{ minHeight: "100vh" }}>
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      <Nav />

      <main id="main">
        <Hero />
        <Inventory />
        <Position />
        <Method />
        <Runtimes />
        <Isolation />
        <Definition />
        <FAQ />
        <CTA />
      </main>

      <Footer />
    </div>
  );
}
