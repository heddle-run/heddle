import type { Metadata } from "next";
import Playground from "@/components/playground/Playground";

export const metadata: Metadata = {
  title: "Playground",
  description:
    "Write an Agent Spec flow, wire tools and plugins, and run it in the browser against a live heddle engine.",
};

export default function PlaygroundPage() {
  return (
    <>
      <a href="#editors" className="skip-link">
        Skip to the editors
      </a>

      <Playground />
    </>
  );
}
