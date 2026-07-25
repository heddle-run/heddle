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
          <span className="font-display text-xl leading-none tracking-tight">
            heddle
            <span className="font-mono text-[0.625rem] tracking-normal text-muted-ink">
              .run
            </span>
          </span>
        ),
        url: "/",
      }}
      links={[{ text: "Documentation", url: "/docs" }]}
      githubUrl={GITHUB_URL}
    >
      {children}
    </DocsLayout>
  );
}
