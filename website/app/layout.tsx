import type { Metadata } from "next";
import {
  IBM_Plex_Mono,
  IBM_Plex_Sans,
  Instrument_Serif,
} from "next/font/google";
import { RootProvider } from "fumadocs-ui/provider";
import Grain from "@/components/Grain";
import { WeaveTexture } from "@/components/WeaveTexture";
/* Vendored system first, site layer second: globals.css ends with the
   site's :root token overrides (printed-ink navy, ivory ground, the Meadow
   accent ramps), and for equal-specificity :root declarations the later
   stylesheet wins. With ds-heddle imported last, every one of those
   overrides silently lost the cascade and the site ran on upstream
   tokens — caught when the Meadow ramps had no effect. */
import "../ds-heddle/styles.css";
import "./globals.css";

/* The three Heddle families, self-hosted through next/font — see
   ds-heddle/DEVIATIONS.md §2. */
const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-plex-sans",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
  display: "swap",
});

const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-instrument",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://heddle.run"),
  title: {
    default: "heddle — A batteries-included declarative agent runtime",
    template: "%s — heddle",
  },
  description:
    "heddle runs multi-step AI jobs described in a plain text file: read these files, decide what matters, write the summary. One free, open-source program on your own computer — with an OS-enforced sandbox, sessions, and the same file runnable behind a server. Flows are written in a published open format, portable to any conforming runtime.",
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
      className={`${plexSans.variable} ${plexMono.variable} ${instrumentSerif.variable}`}
      suppressHydrationWarning
    >
      <body>
        <WeaveTexture variant="faint" style={{ position: "fixed", zIndex: -2 }} />
        <RootProvider
          theme={{
            enabled: true,
            attribute: "class",
            /* The system is light-first, with the navy-black dark theme a
               toggle away. next-themes remains the single source of truth for
               every page, the docs shell included. */
            defaultTheme: "light",
            enableSystem: false,
            disableTransitionOnChange: true,
          }}
        >
          {children}
        </RootProvider>
        <Grain />
      </body>
    </html>
  );
}
