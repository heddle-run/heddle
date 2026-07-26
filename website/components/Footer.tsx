import Link from "next/link";
import Container from "./ui/Container";
import { AGENT_SPEC_URL, GITHUB_URL, NPM_URL } from "@/lib/constants";

const columns = [
  {
    title: "Project",
    links: [
      { label: "Documentation", href: "/docs" },
      { label: "Getting started", href: "/docs/getting-started" },
      { label: "CLI reference", href: "/docs/cli-reference" },
      { label: "Playground", href: "/playground" },
    ],
  },
  {
    title: "Source",
    links: [
      { label: "GitHub", href: GITHUB_URL, external: true },
      { label: "npm", href: NPM_URL, external: true },
      { label: "Examples", href: `${GITHUB_URL}/tree/main/examples`, external: true },
    ],
  },
  {
    title: "Standard",
    links: [
      { label: "Open Agent Spec", href: AGENT_SPEC_URL, external: true },
      { label: "MIT licence", href: `${GITHUB_URL}/blob/main/LICENSE`, external: true },
    ],
  },
];

const linkClass =
  "inline-block border-b border-transparent py-1 font-mono text-xs tracking-wide text-muted-ink transition-colors duration-100 hover:border-ink hover:text-ink focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-ink";

export default function Footer() {
  return (
    <footer className="border-t-8 border-ink">
      <Container className="py-16 md:py-20">
        <div className="grid gap-12 md:grid-cols-12">
          <div className="md:col-span-5">
            <p className="font-display text-4xl leading-none tracking-tight">
              heddle
              <span className="font-mono text-sm tracking-normal text-muted-ink">
                .run
              </span>
            </p>
            <p className="mt-5 max-w-[34ch] text-base leading-relaxed text-muted-ink">
              A CLI runtime for the Open Agent Specification. Open source, MIT
              licensed, and entirely local.
            </p>
          </div>

          {columns.map((column) => (
            <nav
              key={column.title}
              aria-label={column.title}
              className="md:col-span-2"
            >
              <p className="border-b border-hairline pb-3 font-mono text-[0.625rem] uppercase tracking-[0.2em]">
                {column.title}
              </p>
              <ul className="mt-4 space-y-1">
                {column.links.map((link) => (
                  <li key={link.label}>
                    {"external" in link && link.external ? (
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={linkClass}
                      >
                        {link.label}
                      </a>
                    ) : (
                      <Link href={link.href} className={linkClass}>
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-16 flex flex-col gap-3 border-t border-ink pt-6 font-mono text-[0.625rem] uppercase tracking-[0.2em] text-muted-ink sm:flex-row sm:items-center sm:justify-between">
          <p>MIT licensed</p>
          <p>
            Built by{" "}
            <a
              href="https://github.com/spichen"
              target="_blank"
              rel="noopener noreferrer"
              className="border-b border-transparent text-ink transition-colors duration-100 hover:border-ink"
            >
              spichen
            </a>
          </p>
        </div>
      </Container>
    </footer>
  );
}
