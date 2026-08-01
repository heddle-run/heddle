import Nav from "@/components/Nav";
import Hero from "@/components/Hero";
import Manifest from "@/components/Manifest";
import Manifesto from "@/components/Manifesto";
import Steps from "@/components/Steps";
import Features from "@/components/Features";
import SafeMode from "@/components/SafeMode";
import Spread from "@/components/Spread";
import Definition from "@/components/Definition";
import FAQ from "@/components/FAQ";
import CTA from "@/components/CTA";
import Footer from "@/components/Footer";

export default function Home() {
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      <Nav />

      <main id="main">
        <Hero />
        <Manifest />
        <Manifesto />
        <Steps />
        <Features />
        <SafeMode />
        <Spread />
        <Definition />
        <FAQ />
        <CTA />
      </main>

      <Footer />
    </>
  );
}
