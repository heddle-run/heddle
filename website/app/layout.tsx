import type { Metadata } from "next";
import { Archivo, Gentium_Plus, Newsreader } from "next/font/google";
import localFont from "next/font/local";
import { RootProvider } from "fumadocs-ui/provider";
/* Vendored system first, site layer second: globals.css ends with the
   site's :root token overrides (printed-ink navy, ivory ground, the Meadow
   accent ramps), and for equal-specificity :root declarations the later
   stylesheet wins. With ds-heddle imported last, every one of those
   overrides silently lost the cascade and the site ran on upstream
   tokens — caught when the Meadow ramps had no effect. */
import "../ds-heddle/styles.css";
import "./globals.css";

/* The type system, self-hosted through next/font — see
   ds-heddle/DEVIATIONS.md §2 and §4. Three roles, assigned by rule:
   structural (Archivo — the page's own furniture), human (Newsreader —
   anything a person wrote for another person), machine (Commit Mono —
   anything the computer reads or writes). Gentium Plus exists for exactly
   one line: the dictionary block's IPA pronunciation, whose phonetic
   glyphs the other faces cannot promise.

   All variable files. Archivo carries its width axis so long declarative
   headlines can compress optically rather than wrap; Newsreader carries
   optical sizes and a true italic. Commit Mono is not on Google Fonts, so
   its latin woff2s (from @fontsource/commit-mono 5.3.0, SIL OFL) are
   vendored in website/fonts/ and loaded with next/font/local. */
const archivo = Archivo({
  subsets: ["latin"],
  variable: "--font-archivo",
  display: "swap",
  axes: ["wdth"],
});

const newsreader = Newsreader({
  subsets: ["latin"],
  style: ["normal", "italic"],
  variable: "--font-newsreader",
  display: "swap",
  axes: ["opsz"],
});

const commitMono = localFont({
  src: [
    {
      path: "../fonts/commit-mono-latin-400-normal.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "../fonts/commit-mono-latin-500-normal.woff2",
      weight: "500",
      style: "normal",
    },
  ],
  variable: "--font-commit",
  display: "swap",
});

const gentiumPlus = Gentium_Plus({
  subsets: ["latin", "latin-ext"],
  weight: "400",
  variable: "--font-gentium",
  display: "swap",
  preload: false,
});

export const metadata: Metadata = {
  metadataBase: new URL("https://heddle.run"),
  title: {
    default: "heddle — A batteries-included declarative agent runtime",
    template: "%s — heddle",
  },
  description:
    "An agent is a plain text file — the steps, the instructions, the tools — and heddle is the free, open-source program that runs it. Pack a whole agent into one .heddle file, send it to anyone, and it runs on their machine, in a container, or behind a server. Nothing is installed into anything, and the format is a published open standard.",
  keywords: [
    "heddle",
    "declarative agent runtime",
    "batteries included",
    "agent runtime",
    "agent spec",
    "open agent specification",
    "ai agents",
    "agentic workflows",
    "no sdk",
    "declarative agents",
    "shareable agents",
    "agent bundle",
    "portable agents",
    "run agents anywhere",
    "agent sandbox",
    "yaml agents",
    "cli",
    "llm",
  ],
  openGraph: {
    title: "heddle — A batteries-included declarative agent runtime",
    description:
      "An agent is one file you can send. Pack the flow, its tools and its data into a .heddle and it runs anywhere heddle is — your machine, a container, a server — with nothing installed into anything.",
    url: "https://heddle.run",
    siteName: "heddle",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${archivo.variable} ${newsreader.variable} ${commitMono.variable} ${gentiumPlus.variable}`}
      suppressHydrationWarning
    >
      <body>
        <RootProvider
          theme={{
            enabled: true,
            attribute: "class",
            /* The system is dark-first since the Plety redesign — pure black
               is the brand ground, and the landing paints it unconditionally.
               The light theme survives as a toggle in the docs shell.
               next-themes remains the single source of truth for every page. */
            defaultTheme: "dark",
            enableSystem: false,
            disableTransitionOnChange: true,
          }}
        >
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
