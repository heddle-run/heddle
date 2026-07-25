import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Geist, Instrument_Serif } from "next/font/google";
import { RootProvider } from "fumadocs-ui/provider";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
});

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
});

const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-instrument-serif",
});

export const metadata: Metadata = {
  title: "Heddle - Build Agentic AI Workflows from the CLI",
  description:
    "A lightweight CLI framework for building and running agentic AI workflows using the Open Agent Specification. Define in YAML, wire tools in any language, run from one command.",
  keywords: [
    "heddle",
    "ai agents",
    "agentic workflows",
    "cli",
    "llm",
    "open agent specification",
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable} ${geist.variable} ${instrumentSerif.variable}`}>
      <body className="font-sans">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
