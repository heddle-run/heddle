import Link from "next/link";
import { Github } from "lucide-react";
import Container from "./ui/Container";
import { GITHUB_URL, VERSION } from "@/lib/constants";

const links = [
  { label: "Method", href: "/#method" },
  { label: "Specimens", href: "/#specimens" },
  { label: "Docs", href: "/docs" },
];

export default function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-ink bg-paper">
      <Container className="flex h-16 items-center justify-between md:h-20">
        <div className="flex items-baseline gap-3">
          <Link
            href="/"
            className="font-display text-2xl leading-none tracking-tight focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-4 focus-visible:outline-ink"
          >
            heddle
            <span className="font-mono text-xs tracking-normal text-muted-ink">
              .run
            </span>
          </Link>
          <span className="hidden font-mono text-[0.625rem] uppercase tracking-[0.2em] text-muted-ink sm:inline">
            v{VERSION}
          </span>
        </div>

        <nav aria-label="Primary" className="flex items-stretch self-stretch">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="hidden items-center border-l border-hairline px-5 font-mono text-[0.6875rem] uppercase tracking-[0.2em] transition-colors duration-100 hover:bg-ink hover:text-paper focus-visible:outline focus-visible:outline-[3px] focus-visible:-outline-offset-[3px] focus-visible:outline-ink sm:flex"
            >
              {link.label}
            </Link>
          ))}
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 border-l border-hairline px-5 font-mono text-[0.6875rem] uppercase tracking-[0.2em] transition-colors duration-100 hover:bg-ink hover:text-paper focus-visible:outline focus-visible:outline-[3px] focus-visible:-outline-offset-[3px] focus-visible:outline-ink"
          >
            <Github size={16} strokeWidth={1.5} />
            <span className="sr-only sm:not-sr-only">GitHub</span>
          </a>
        </nav>
      </Container>
    </header>
  );
}
