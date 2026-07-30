import type { Metadata } from "next";
import Compare from "@/components/compare/Compare";

export const metadata: Metadata = {
  title: "Compare",
  description:
    "The same three agent use cases written in heddle, LangGraph, the OpenAI Agents SDK and Google ADK, side by side.",
};

export default function ComparePage() {
  return (
    <>
      <a href="#panes" className="skip-link">
        Skip to the code
      </a>

      <Compare />
    </>
  );
}
