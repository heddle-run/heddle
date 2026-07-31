import type { Metadata } from "next";
import Redirect from "@/components/Redirect";
import { COMPARE_URL } from "@/lib/constants";

/**
 * /compare was its own page until the comparison became a view of the
 * playground. Links to it outlive the merge, so the route stays and forwards.
 *
 * On Pages this is a 301 from public/_redirects and the reader never sees
 * this document; it is what serves the same links anywhere else — a local
 * build, a preview, a fork.
 */
export const metadata: Metadata = {
  title: "Compare",
  description:
    "The same three agent use cases written in heddle, LangGraph, the OpenAI Agents SDK and Google ADK, side by side.",
  alternates: { canonical: COMPARE_URL },
  robots: { index: false, follow: true },
};

export default function ComparePage() {
  return <Redirect to={COMPARE_URL} label="the comparison" />;
}
