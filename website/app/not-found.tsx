import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import Container from "@/components/ui/Container";
import Texture from "@/components/ui/Texture";
import Button from "@/components/ui/Button";
import Label from "@/components/ui/Label";

export default function NotFound() {
  return (
    <>
      <Nav />

      <main className="relative overflow-hidden border-b-4 border-ink">
        <Texture variant="warp" />

        <Container className="relative py-32 md:py-44">
          <Label>Error — 404</Label>

          <h1 className="mt-8 font-display text-[4.5rem] italic leading-[0.8] tracking-tighter sm:text-8xl lg:text-9xl">
            Dropped
          </h1>
          <p className="mt-3 font-display text-4xl leading-none tracking-tight sm:text-5xl">
            a thread.
          </p>

          <div className="mt-12 flex items-center">
            <span aria-hidden className="h-1 flex-1 bg-ink" />
            <span aria-hidden className="ml-4 h-4 w-4 border-2 border-ink" />
          </div>

          <p className="mt-12 max-w-[46ch] text-xl leading-relaxed text-muted-ink">
            This page is not part of the weave. Head back to the front, or pick
            the pattern up in the documentation.
          </p>

          <div className="mt-10 flex flex-col gap-4 sm:flex-row">
            <Button href="/">Return home</Button>
            <Button href="/docs" variant="secondary">
              Documentation
            </Button>
          </div>
        </Container>
      </main>

      <Footer />
    </>
  );
}
