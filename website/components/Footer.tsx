import { Github } from "lucide-react";
import { GITHUB_URL, NPM_URL } from "@/lib/constants";

export default function Footer() {
  return (
    <footer className="border-t border-card-border py-12">
      <div className="mx-auto flex max-w-7xl flex-col items-center gap-6 px-6 text-center">
        <p className="text-sm text-text-muted">
          Heddle is open source and MIT licensed.
        </p>

        <div className="flex items-center gap-6">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-sm text-white/50 transition-colors hover:text-white"
          >
            <Github className="h-4 w-4" />
            GitHub
          </a>
          <a
            href={NPM_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-white/50 transition-colors hover:text-white"
          >
            npm
          </a>
          <a
            href={`${GITHUB_URL}/tree/main/examples`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-white/50 transition-colors hover:text-white"
          >
            Examples
          </a>
          <a
            href={`${GITHUB_URL}#readme`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-white/50 transition-colors hover:text-white"
          >
            Docs
          </a>
        </div>

        <p className="text-xs text-white/30">
          Built by{" "}
          <a
            href="https://github.com/spichen"
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-white/50"
          >
            spichen
          </a>
        </p>
      </div>
    </footer>
  );
}
