import type { Metadata } from "next";
import Playground from "@/components/playground/Playground";
import { PLAYGROUND_URL } from "@/lib/constants";

export const metadata: Metadata = {
  title: "Playground",
  description:
    "Write an Agent Spec flow, wire tools and plugins, and run it in the browser against a live heddle engine — or read the same use case in heddle, LangGraph, the OpenAI Agents SDK and Google ADK, side by side.",
  /* This export is served both at /playground and at the root of the
     playground subdomain. They are one page, and this says which address it
     is. Relative when no subdomain is configured, which resolves to itself. */
  alternates: { canonical: PLAYGROUND_URL },
};

export default function PlaygroundPage() {
  return (
    <>
      <a href="#panes" className="skip-link">
        Skip to the panes
      </a>

      <Playground />
    </>
  );
}
