"use client";

import GradientBlobs from "./GradientBlobs";
import SectionReveal from "./SectionReveal";

export default function CTA() {
  return (
    <section id="get-started" className="relative overflow-hidden py-32">
      <GradientBlobs className="opacity-60" />

      <div className="relative z-10 mx-auto max-w-3xl px-6 text-center">
        <SectionReveal>
          <h2 className="text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl">
            Get started in seconds
          </h2>
        </SectionReveal>

        <SectionReveal delay={0.1}>
          <div className="mt-12 overflow-hidden rounded-2xl border border-card-border bg-card p-6 text-left">
            <pre className="overflow-x-auto font-mono text-sm leading-relaxed">
              <code>
                <span className="terminal-comment syntax-comment">
                  # Install via npm
                </span>
                {"\n"}
                <span className="terminal-prompt">$</span>{" "}
                <span className="terminal-command">npm install -g</span>{" "}
                <span className="terminal-string">@heddle/cli</span>
                {"\n\n"}
                <span className="syntax-comment"># Or via Homebrew</span>
                {"\n"}
                <span className="terminal-prompt">$</span>{" "}
                <span className="terminal-command">brew install</span>{" "}
                <span className="terminal-string">spichen/tap/heddle</span>
                {"\n\n"}
                <span className="syntax-comment">
                  # Create and run your first agent
                </span>
                {"\n"}
                <span className="terminal-prompt">$</span>{" "}
                <span className="terminal-command">heddle init</span>{" "}
                <span className="terminal-string">my-agent</span>
                {"\n"}
                <span className="terminal-prompt">$</span>{" "}
                <span className="terminal-command">heddle run</span>{" "}
                <span className="terminal-string">
                  my-agent/flow.json
                </span>{" "}
                <span className="terminal-flag">--tools-dir</span>{" "}
                <span className="terminal-string">my-agent/tools</span>
              </code>
            </pre>
          </div>
        </SectionReveal>

        <SectionReveal delay={0.2}>
          <a
            href={`https://github.com/spichen/specrun#readme`}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-10 inline-block rounded-full bg-white px-10 py-4 text-lg font-medium text-black transition-opacity hover:opacity-90"
          >
            Get Started
          </a>
        </SectionReveal>
      </div>
    </section>
  );
}
