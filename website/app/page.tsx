import Nav from "@/components/Nav";
import Hero from "@/components/Hero";
import Manifesto from "@/components/Manifesto";
import Steps from "@/components/Steps";
import Stats from "@/components/Stats";
import Features from "@/components/Features";
import Specimens from "@/components/Specimens";
import Spread from "@/components/Spread";
import Definition from "@/components/Definition";
import FAQ from "@/components/FAQ";
import CTA from "@/components/CTA";
import Footer from "@/components/Footer";
import Rule from "@/components/ui/Rule";

export default function Home() {
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      <Nav />

      <main id="main">
        <Hero />
        <Rule />
        <Manifesto />
        <Rule />
        <Steps />
        {/* The inverted band divides by mass; it needs no rule of its own. */}
        <Stats />
        <Features />
        <Rule />
        <Specimens />
        <Rule />
        <Spread />
        <Rule />
        <Definition />
        <Rule />
        <FAQ />
        <CTA />
      </main>

      <Footer />
    </>
  );
}
