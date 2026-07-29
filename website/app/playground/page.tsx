import type { Metadata } from "next";
import Playground from "@/components/playground/Playground";

export const metadata: Metadata = {
  title: "Playground",
  description:
    "Write an Agent Spec flow, wire tools and plugins, and run it in the browser against a live heddle engine.",
};

/**
 * The playground takes the whole viewport.
 *
 * Every other page on the site is a document — nav, sections, footer. This one
 * is an application: the editors and the run log are the page, and the site's
 * chrome would only take height away from them. The way back out is the
 * wordmark in the playground's own bar.
 */
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
