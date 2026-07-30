import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { RootProvider } from "fumadocs-ui/provider";
import { Backdrop } from "@/ds";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://heddle.run"),
  title: {
    default: "heddle — Weave agents from spec",
    template: "%s — heddle",
  },
  description:
    "Build agents without an SDK. heddle is a runtime for the Open Agent Specification: declare the flow as a YAML or JSON document, wire tools in any language, and run it from the CLI or behind an HTTP server — with every tool confined to a sandbox under --safe.",
  keywords: [
    "heddle",
    "agent spec",
    "open agent specification",
    "ai agents",
    "agentic workflows",
    "no sdk",
    "declarative agents",
    "agent sandbox",
    "cli",
    "llm",
  ],
  openGraph: {
    title: "heddle — Weave agents from spec",
    description:
      "No SDK, no imports. Declare the agent as a document and run it from the CLI or an HTTP server, with tools confined to a sandbox.",
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
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body>
        <RootProvider
          theme={{
            enabled: true,
            attribute: "class",
            defaultTheme: "dark",
            enableSystem: false,
            disableTransitionOnChange: true,
          }}
        >
          <Backdrop />
          <div className="hd-content">{children}</div>
        </RootProvider>
      </body>
    </html>
  );
}
