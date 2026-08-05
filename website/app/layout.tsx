import type { Metadata } from "next";
import {
  IBM_Plex_Mono,
  IBM_Plex_Sans,
  Instrument_Serif,
} from "next/font/google";
import { RootProvider } from "fumadocs-ui/provider";
import Grain from "@/components/Grain";
import { WeaveTexture } from "@/components/WeaveTexture";
import "./globals.css";
import "../ds-heddle/styles.css";

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
    "A batteries-included declarative agent runtime. The tool-calling loop, OS-level sandbox, HTTP server, guardrails and retry policies ship with heddle, and none of them enter your codebase. Declare the flow as an Open Agent Specification document in YAML or JSON, wire tools in any language, and run it from the CLI or behind an HTTP server.",
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
      "Sandbox, HTTP server, guardrails, retries and streaming already in the runtime, and none of it in your codebase. Declare the agent as a document and point heddle at it.",
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
        <WeaveTexture variant="faint" style={{ position: "fixed", zIndex: -1 }} />
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
