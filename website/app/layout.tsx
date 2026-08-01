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
    default: "heddle — A batteries-included declarative agent runtime",
    template: "%s — heddle",
  },
  description:
    "A batteries-included declarative agent runtime. The tool-calling loop, OS-level sandbox, HTTP server, guardrails and retry policies ship with heddle — and none of them enter your codebase. Declare the flow as an Open Agent Specification document in YAML or JSON, wire tools in any language, and run it from the CLI or behind an HTTP server.",
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
      "Sandbox, HTTP server, guardrails, retries and streaming already in the runtime — and none of it in your codebase. Declare the agent as a document and point heddle at it.",
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
