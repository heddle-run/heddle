import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";
import { source } from "@/lib/source";
import { GITHUB_URL } from "@/lib/constants";
import Wordmark from "@/components/Wordmark";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.pageTree}
      nav={{ title: <Wordmark size="sm" />, url: "/" }}
      links={[{ text: "Documentation", url: "/docs" }]}
      githubUrl={GITHUB_URL}
    >
      {children}
    </DocsLayout>
  );
}
