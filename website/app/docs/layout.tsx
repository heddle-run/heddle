import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";
import { source } from "@/lib/source";
import { GITHUB_URL } from "@/lib/constants";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.pageTree}
      nav={{
        title: (
          <span className="font-semibold tracking-tight">heddle</span>
        ),
        url: "/",
      }}
      links={[
        { text: "Docs", url: "/docs" },
      ]}
      githubUrl={GITHUB_URL}
    >
      {children}
    </DocsLayout>
  );
}
