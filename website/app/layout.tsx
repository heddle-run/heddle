import type { Metadata } from "next";
import { Playfair_Display, Source_Serif_4, JetBrains_Mono } from "next/font/google";
import { RootProvider } from "fumadocs-ui/provider";
import "./globals.css";

const playfair = Playfair_Display({
  subsets: ["latin"],
  style: ["normal", "italic"],
  variable: "--font-playfair",
});

const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  style: ["normal", "italic"],
  variable: "--font-source-serif",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://heddle.run"),
  title: {
    default: "heddle — Weave agents from spec",
    template: "%s — heddle",
  },
  description:
    "heddle is a lightweight CLI runtime for the Open Agent Specification. Declare a flow in YAML, wire tools in any language, and run the whole thing from one command.",
  keywords: [
    "heddle",
    "agent spec",
    "open agent specification",
    "ai agents",
    "agentic workflows",
    "cli",
    "llm",
  ],
  openGraph: {
    title: "heddle — Weave agents from spec",
    description:
      "A lightweight CLI runtime for the Open Agent Specification. Declare the flow, wire the tools, run one command.",
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
      className={`${playfair.variable} ${sourceSerif.variable} ${jetbrainsMono.variable}`}
    >
      <body className="bg-paper font-body text-ink antialiased">
        <RootProvider theme={{ enabled: false }}>{children}</RootProvider>
      </body>
    </html>
  );
}
