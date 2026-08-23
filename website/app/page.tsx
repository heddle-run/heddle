import Landing from "@/components/landing/Landing";

/* The landing page is the single-file Plety-derived composition in
   components/landing/Landing.tsx: pure black, white type, scroll-reveal
   chapters over ambient video — nav, hero, marquee, two features, FAQ and
   footer all live in that one file. This wrapper exists so the page itself
   stays a server component and the metadata in app/layout.tsx applies. */
export default function Home() {
  return <Landing />;
}
