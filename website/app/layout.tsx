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
    "heddle runs multi-step AI jobs described in a plain text file: read these files, decide what matters, write the summary. One free, open-source program on your own computer — with an OS-enforced sandbox, sessions, and the same file runnable behind a server. Flows are written in Weave, an open, documented format: one plain file that says everything the runtime will do.",
  keywords: [
    "heddle",
    "declarative agent runtime",
    "batteries included",
    "agent runtime",
    "weave",
    "weave format",
    "ai agents",
    "agentic workflows",
    "no sdk",
    "declarative agents",
    "agent sandbox",
    "yaml agents",
    "cli",
    "llm",
  ],
  openGraph: {
    title: "heddle — A batteries-included declarative agent runtime",
    description:
      "Multi-step AI jobs described in a plain text file, run by one free program on your own computer. Sandbox, sessions and a server included; the file is an open format you are not locked into.",
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
