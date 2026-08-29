"use client";

import { useEffect, useRef, useState } from "react";
import {
  COMPARE_URL,
  GITHUB_URL,
  NPM_URL,
  PLAYGROUND_URL,
  bundle,
  faqItems,
} from "@/lib/constants";

/* The landing page, single-file on purpose: the whole Plety-derived
   composition — nav, hero, marquee, two feature chapters, FAQ, footer — and
   the FadeInUp scroll-reveal it shares, in one place. Pure black ground,
   white type, hairline white/10 rules, pill controls; the serif italic
   accent inside each display headline is Newsreader via --font-serif.
   Copy still comes from lib/constants.ts wherever a section says something
   checkable — the FAQ answers, the notetaker claims and every line of the
   bundle transcript are quoted, not re-invented. The marquee names platforms
   heddle actually runs on, never invented customers.

   What the page argues, in order: an agent is a file (hero), the file
   travels and runs wherever heddle is (sharing), and here is what one of
   them does (chat, notetaker). The sharing chapter is the pivot — it is the
   reason the marquee's platform list means anything — so it leads the
   features and owns the #features anchor. */

const DOCS_URL = "/docs";

/* Self-hosted: an AI-generated weave — glowing warp threads on black —
   served from public/media rather than a third-party CDN. Also the footer's
   backdrop, so it downloads once and plays twice. */
const HERO_VIDEO = "/media/hero-threads.mp4";
/* The feature backdrops, generated as siblings of the hero: two strands —
   amber and steel — twisting into one braid behind the chat card, and the
   finished emerald cloth with a gold thread rippling behind the notetaker.
   Threads, braid, cloth: the loom story in order down the page. */
const CHAT_VIDEO = "/media/chat-braid.mp4";
const NOTES_VIDEO = "/media/woven-cloth.mp4";

const serif = { fontFamily: "var(--font-serif)" };

/* ── FadeInUp ─────────────────────────────────────────────────────────────
   The one reveal the page uses: slide up from translate-y-10/opacity-0 over
   1000ms, once, when the element enters the viewport. The global
   prefers-reduced-motion rule zeroes the duration, so there it appears
   settled rather than performed. */
function FadeInUp({
  children,
  delay = 0,
  className = "",
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold: 0.1 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      style={{ transitionDelay: `${delay}ms` }}
      className={`transition-all duration-1000 ease-out ${
        shown ? "opacity-100 translate-y-0" : "opacity-0 translate-y-10"
      } ${className}`}
    >
      {children}
    </div>
  );
}

/* ── The mark ─────────────────────────────────────────────────────────────
   A stroke-drawn heddle: three warp threads and the weft passing over and
   under them. Minimal, geometric, currentColor — the same 1.5px stroke
   language as every icon on the page. */
function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 28 28"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M7 4v20" />
      <path d="M14 4v20" />
      <path d="M21 4v20" />
      <path d="M2.5 14c3-5.5 6-5.5 9 0s6 5.5 9 0 4-4.5 5-2.5" />
    </svg>
  );
}

function GetStartedButton({ href = DOCS_URL }: { href?: string }) {
  return (
    <a
      href={href}
      className="pl-btn-light bg-white hover:bg-gray-200 text-sm font-medium px-5 py-2.5 rounded-full transition-colors"
    >
      Get started
    </a>
  );
}

function LearnMoreButton({ href = "#features" }: { href?: string }) {
  return (
    <a
      href={href}
      className="pl-btn-dark bg-[#1F1F22] hover:bg-[#2A2A2D] text-sm font-medium px-5 py-2.5 rounded-full border border-white/5 transition-colors"
    >
      Learn more
    </a>
  );
}

/* ── 1 · Navigation ───────────────────────────────────────────────────────
   Fixed, transparent at the top, glassing to black past 20px of scroll.
   Mobile gets the hamburger and a dropdown that closes itself when a link
   is tapped; the html-level scroll-behavior: smooth carries the rest. */
const NAV_LINKS = [
  { label: "About", href: "#about" },
  { label: "Features", href: "#features" },
  { label: "FAQ", href: "#faq" },
  { label: "Contact", href: "#contact" },
];

function NavBar() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const glassed = scrolled || open;

  return (
    <header
      className={`fixed top-0 inset-x-0 z-50 transition-colors duration-300 ${
        glassed ? "bg-black/80 backdrop-blur-md" : "bg-transparent"
      }`}
    >
      <div className="max-w-7xl mx-auto px-6">
        <nav className="relative flex items-center justify-between h-16">
          <a
            href="#about"
            className="pl-brand flex items-center gap-2.5"
            aria-label="heddle — home"
          >
            <Logo />
            <span
              className="text-base font-medium lowercase"
              style={{ fontFamily: "var(--font-mono)", letterSpacing: "0.02em" }}
            >
              heddle
            </span>
          </a>

          <div className="hidden md:flex items-center gap-8 absolute left-1/2 -translate-x-1/2">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="pl-navlink text-sm font-medium transition-colors"
              >
                {link.label}
              </a>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <a
              href={DOCS_URL}
              className="pl-btn-dark hidden md:inline-block bg-[#1F1F22] hover:bg-[#2A2A2D] text-sm font-medium px-5 py-2.5 rounded-full border border-white/5 transition-colors"
            >
              Get started
            </a>
            <button
              type="button"
              className="md:hidden p-2 -mr-2 text-gray-300 hover:text-white"
              aria-expanded={open}
              aria-label={open ? "Close menu" : "Open menu"}
              onClick={() => setOpen((v) => !v)}
            >
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                strokeLinecap="round"
              >
                {open ? (
                  <path d="M5 5l14 14M19 5L5 19" />
                ) : (
                  <path d="M4 7h16M4 12h16M4 17h16" />
                )}
              </svg>
            </button>
          </div>
        </nav>
      </div>

      {/* The mobile dropdown: height-animated, and every link closes it. */}
      <div
        className={`md:hidden overflow-hidden transition-all duration-300 ease-out ${
          open ? "max-h-80 opacity-100" : "max-h-0 opacity-0"
        } bg-black/90 backdrop-blur-md border-b border-white/5`}
      >
        <div className="px-6 pb-6 pt-2 flex flex-col gap-1">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className="pl-navlink py-3 text-sm font-medium transition-colors"
            >
              {link.label}
            </a>
          ))}
          <a
            href={DOCS_URL}
            onClick={() => setOpen(false)}
            className="pl-btn-dark mt-3 self-start bg-[#1F1F22] hover:bg-[#2A2A2D] text-sm font-medium px-5 py-2.5 rounded-full border border-white/5 transition-colors"
          >
            Get started
          </a>
        </div>
      </div>
    </header>
  );
}

/* ── 2 · Hero ─────────────────────────────────────────────────────────────
   One viewport over the ambient video, and beneath it the marquee — the
   platforms a run actually lands on, looping seamlessly behind a mask. */
const PLATFORMS = [
  { name: "macOS", glyph: <circle cx="12" cy="12" r="8.5" /> },
  {
    name: "Linux",
    glyph: <path d="M12 3.5l8 14.5H4l8-14.5z" strokeLinejoin="round" />,
  },
  {
    name: "Docker",
    glyph: (
      <path
        d="M5 5.5h14v13H5v-13zM5 10h14M10 5.5v4.5"
        strokeLinejoin="round"
      />
    ),
  },
  {
    name: "Kubernetes",
    glyph: (
      <path
        d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9L12 3z"
        strokeLinejoin="round"
      />
    ),
  },
  {
    name: "npx",
    glyph: <path d="M6 8l5 4-5 4M13 16.5h5" strokeLinejoin="round" />,
  },
];

function Marquee() {
  return (
    <div className="w-full mt-24">
      <p className="text-sm text-gray-500 font-medium mb-8 text-center">
        One file. Runs where you already work
      </p>
      <div
        className="overflow-hidden"
        style={{
          maskImage:
            "linear-gradient(to right, transparent, black 15%, black 85%, transparent)",
          WebkitMaskImage:
            "linear-gradient(to right, transparent, black 15%, black 85%, transparent)",
        }}
      >
        {/* Four identical groups and a -25% keyframe: the loop closes on
            itself with the frame always full, whatever the viewport. */}
        <div className="flex w-max animate-[marquee_30s_linear_infinite]">
          {Array.from({ length: 4 }).flatMap((_, copy) =>
            PLATFORMS.map((p) => (
              <div
                key={`${copy}-${p.name}`}
                className="flex-shrink-0 px-8 flex items-center gap-3 text-gray-500"
                aria-hidden={copy > 0}
              >
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                >
                  {p.glyph}
                </svg>
                <span className="text-base font-medium whitespace-nowrap">
                  {p.name}
                </span>
              </div>
            )),
          )}
        </div>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <section
      id="about"
      className="min-h-screen flex flex-col items-center justify-center pt-32 pb-20 relative z-0 px-6"
    >
      <video
        className="absolute inset-0 -z-10 min-w-full min-h-full w-full h-full object-cover opacity-90"
        src={HERO_VIDEO}
        autoPlay
        muted
        loop
        playsInline
      />
      <div className="absolute inset-0 -z-10 bg-gradient-to-b from-black/30 via-transparent to-black" />

      <FadeInUp className="flex flex-col items-center">
        <span className="px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-xs font-medium text-gray-300 mb-8 backdrop-blur-sm">
          ✨ Early release — now with an agent library
        </span>

        <h1 className="text-5xl md:text-7xl font-medium tracking-tight mb-6 text-center text-white">
          A batteries-included
          <br />
          declarative agent{" "}
          <span className="italic font-normal" style={serif}>
            runtime.
          </span>
        </h1>

        <p className="text-[16px] text-gray-400 max-w-2xl text-center mb-10">
          An agent is a plain text file — the steps, the instructions, the
          tools. heddle is the free, open-source program that reads one and
          does the job. Send the file to anyone and it runs on their machine
          the way it ran on yours; nothing is installed into anything.
        </p>

        <div className="flex flex-row items-center gap-3">
          <GetStartedButton />
          <LearnMoreButton />
        </div>
      </FadeInUp>

      <FadeInUp delay={150} className="w-full">
        <Marquee />
      </FadeInUp>
    </section>
  );
}

/* ── Shared feature furniture ─────────────────────────────────────────── */
function FeatureText({
  badge,
  badgeClass,
  headline,
  copy,
}: {
  badge: string;
  badgeClass: string;
  headline: React.ReactNode;
  copy: string;
}) {
  return (
    <div className="flex flex-col items-start justify-center">
      <span className={`text-xs font-medium mb-4 ${badgeClass}`}>{badge}</span>
      <h2 className="text-4xl md:text-5xl font-semibold tracking-tight mb-5 text-white">
        {headline}
      </h2>
      <p className="text-[16px] text-gray-400 mb-8">{copy}</p>
      <GetStartedButton />
    </div>
  );
}

function MockupFrame({
  video,
  children,
}: {
  video: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-3xl overflow-hidden p-8 border border-white/10 relative min-h-[24rem] flex items-end">
      <video
        className="absolute inset-0 object-cover w-full h-full"
        src={video}
        autoPlay
        muted
        loop
        playsInline
      />
      <div className="absolute inset-0 bg-black/20" />
      {children}
    </div>
  );
}

/* ── 3 · Feature: the file that travels ───────────────────────────────── */
/* The mock is a terminal rather than a device card, because the argument
   here is a transcript: what packing prints, and the three addresses one
   command opens. Both come from `bundle` in lib/constants.ts, which is the
   real CLI's output — re-pack library/local-notetaker before touching a
   character. The window keeps the page's own surfaces (black glass, white/10
   hairline) rather than importing a code theme the rest of the page does not
   use. */
function BundleMockCard() {
  return (
    <div className="relative w-full bg-[#1C1C1E]/90 backdrop-blur-xl border border-white/10 rounded-2xl overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/10">
        <span className="w-2.5 h-2.5 rounded-full bg-white/20" />
        <span className="w-2.5 h-2.5 rounded-full bg-white/20" />
        <span className="w-2.5 h-2.5 rounded-full bg-white/20" />
        <span
          className="ml-2 text-xs text-gray-500"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          zsh — heddle
        </span>
      </div>
      {/* Size and leading are inline, not utilities: ds-heddle/styles.css
          styles bare `pre` and loads after globals.css unlayered, so it beats
          any Tailwind text-* class here (a text-[11px] silently rendered at
          15px). 11px is what makes the CLI's longest line — its own "Run it
          anywhere with: …" — fit the half-width column instead of leaving an
          11px horizontal scroll to discover; re-measure if the transcript
          changes. */}
      <pre
        className="px-4 py-4 text-gray-400 overflow-x-auto"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          lineHeight: 1.65,
          margin: 0,
        }}
      >
        {bundle.pack}
      </pre>
      <div className="px-4 pb-4 pt-1 border-t border-white/10">
        <p className="text-[11px] text-gray-500 mt-3 mb-2">
          One command opens all three:
        </p>
        {/* One scroll container around all three, not one each: on a phone
            the lines are wider than the card, and three separate scrollbars
            stacked three rows deep read as damage rather than as a
            terminal. */}
        <div
          className="overflow-x-auto"
          style={{ fontFamily: "var(--font-mono)", fontSize: 11.5 }}
        >
          {bundle.send.map((cmd) => (
            <div key={cmd} className="text-gray-300 whitespace-pre">
              <span className="text-gray-600">$ </span>
              {cmd}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function FeatureBundle() {
  return (
    <section id="features" className="scroll-mt-16">
      <div className="grid lg:grid-cols-2 gap-16 pt-24 pb-12 px-6 max-w-7xl mx-auto">
        <FadeInUp className="min-w-0">
          <FeatureText
            badge="✨ One file"
            badgeClass="text-orange-200"
            headline={
              <>
                An agent you can{" "}
                <span className="italic font-normal" style={serif}>
                  send.
                </span>
              </>
            }
            copy="An agent is rarely just its instructions: by the time it works it is a flow, a folder of tools, the files those tools read and the settings they run with. heddle packs all of it into a single .heddle file — and that file is the agent. Email it, put it at an address, or publish it to the library."
          />
        </FadeInUp>
        <FadeInUp delay={150} className="min-w-0">
          <MockupFrame video={HERO_VIDEO}>
            <BundleMockCard />
          </MockupFrame>
        </FadeInUp>
      </div>

      {/* What travels, what does not, and what the file asks of whoever
          opens it — the three questions a person asks the moment sending
          becomes the point. Hairline-ruled rather than carded: it is a
          footnote to the chapter above, not a third pitch. */}
      <div className="max-w-7xl mx-auto px-6 pb-24">
        <FadeInUp delay={100}>
          <div className="grid md:grid-cols-3 gap-px bg-white/10 border border-white/10 rounded-2xl overflow-hidden">
            {bundle.travels.map((fact) => (
              <div key={fact.title} className="bg-black p-6">
                <h3 className="text-sm font-medium text-white mb-2">
                  {fact.title}
                </h3>
                <p className="text-sm text-gray-400 leading-relaxed">
                  {fact.detail}
                </p>
              </div>
            ))}
          </div>
        </FadeInUp>
      </div>
    </section>
  );
}

/* ── 4 · Feature: interactive chat ────────────────────────────────────── */
function ChatMockCard() {
  return (
    <div className="relative w-full bg-[#1C1C1E]/90 backdrop-blur-xl border border-white/10 rounded-2xl p-4">
      <div className="flex flex-wrap gap-2 mb-4">
        {["Summarise the folder", "Plan the fix", "Draft the reply"].map(
          (chip) => (
            <span
              key={chip}
              className="px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-xs text-gray-300"
            >
              {chip}
            </span>
          ),
        )}
      </div>
      <div className="flex items-center gap-3 rounded-xl bg-black/40 border border-white/10 px-4 py-3">
        <span className="flex-1 text-sm text-gray-500">Ask anything...</span>
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          className="text-gray-400"
          aria-hidden="true"
        >
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
        </svg>
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          className="text-gray-400"
          aria-hidden="true"
        >
          <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />
        </svg>
      </div>
    </div>
  );
}

function FeatureChat() {
  return (
    <section>
      <div className="grid lg:grid-cols-2 gap-16 py-24 px-6 max-w-7xl mx-auto">
        <FadeInUp delay={150} className="order-last lg:order-last min-w-0">
          <FeatureText
            badge="✨ Interactive chat"
            badgeClass="text-yellow-200"
            headline={
              <>
                Where speed meets intelligent{" "}
                <span className="italic font-normal" style={serif}>
                  conversation.
                </span>
              </>
            }
            copy="Open any flow as a conversation. heddle keeps the transcript on your own disk, shows exactly what was said and which tools ran, and picks the session back up later — on your machine or over the server."
          />
        </FadeInUp>
        <FadeInUp className="order-first lg:order-first min-w-0">
          <MockupFrame video={CHAT_VIDEO}>
            <ChatMockCard />
          </MockupFrame>
        </FadeInUp>
      </div>
    </section>
  );
}

/* ── 5 · Feature: the local notetaker ─────────────────────────────────── */
function NotesMockCard() {
  const bars = [
    5, 9, 14, 8, 16, 11, 18, 7, 12, 17, 9, 14, 6, 11, 16, 8, 13, 18, 10, 15,
    7, 12, 9, 14, 6,
  ];
  return (
    <div className="relative w-full bg-[#1C1C1E]/90 backdrop-blur-xl border border-white/10 rounded-2xl p-4">
      <div className="flex items-center gap-3 mb-4">
        <span className="flex items-center justify-center w-9 h-9 rounded-full bg-white text-black flex-shrink-0">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M8 5.5v13l11-6.5-11-6.5z" />
          </svg>
        </span>
        <span className="text-sm text-gray-300 font-medium whitespace-nowrap">
          11:06 AM – Chris
        </span>
        <div
          className="flex items-center gap-[3px] flex-1 min-w-0 overflow-hidden"
          aria-hidden="true"
        >
          {bars.map((h, i) => (
            <span
              key={i}
              className="w-[3px] rounded-full bg-white/50 flex-shrink-0"
              style={{ height: h }}
            />
          ))}
        </div>
      </div>
      <p className="text-sm text-gray-400 leading-relaxed">
        …so the decision is we ship the beta on Thursday. Chris owns the
        changelog, and pricing stays an open question for next week…
      </p>
    </div>
  );
}

function FeatureNotes() {
  return (
    <section>
      <div className="grid lg:grid-cols-2 gap-16 py-24 px-6 max-w-7xl mx-auto">
        <FadeInUp className="min-w-0">
          <FeatureText
            badge="✨ Local notetaker"
            badgeClass="text-green-300"
            headline={
              <>
                Turn meetings into notes on your own{" "}
                <span className="italic font-normal" style={serif}>
                  machine.
                </span>
              </>
            }
            copy="It listens from your own computer — no bot joins the call, and the audio never leaves your machine. Stop it when the meeting ends and you get the summary, the decisions, the action items and the open questions. It is one of the library's files: run it by name, or open it and change a line."
          />
        </FadeInUp>
        <FadeInUp delay={150} className="min-w-0">
          <MockupFrame video={NOTES_VIDEO}>
            <NotesMockCard />
          </MockupFrame>
        </FadeInUp>
      </div>
    </section>
  );
}

/* ── 6 · FAQ ──────────────────────────────────────────────────────────────
   Seven of the real answers from lib/constants.ts, quoted in full. The
   accordion animates with the grid-template-rows 0fr→1fr trick, and the
   plus rotates 45° into a close.

   Two of the seven exist because the page now says "send this to people":
   how you hand an agent over, and what it means to be handed one. A page
   that invites a file to travel and does not say what a received file can
   do has left its reader with the question it created. */
const FAQ_QUESTIONS = [
  "What is heddle?",
  "How do I give an agent to someone else?",
  "Someone sent me a .heddle file. Is it safe to run?",
  "Do I need to know how to program?",
  "Where does my data go?",
  "What does it cost to run?",
  "Am I locked in?",
];

const faq = FAQ_QUESTIONS.map(
  (q) => faqItems.find((item) => item.question === q),
).filter((item): item is (typeof faqItems)[number] => item !== undefined);

function FaqItem({
  item,
  last,
  open,
  onToggle,
}: {
  item: { question: string; answer: string };
  last: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={last ? "" : "border-b border-white/10"}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-4 py-6 px-6 text-left"
      >
        <span className="text-base text-white font-medium">
          {item.question}
        </span>
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          className={`flex-shrink-0 text-gray-400 transition-transform duration-300 ${
            open ? "rotate-45" : ""
          }`}
          aria-hidden="true"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <p className="text-gray-400 text-sm pb-6 px-6">{item.answer}</p>
        </div>
      </div>
    </div>
  );
}

function Faq() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);
  return (
    <section id="faq" className="py-32 px-6 max-w-3xl mx-auto scroll-mt-16">
      <FadeInUp>
        <h2 className="text-4xl md:text-5xl font-semibold tracking-tight mb-12 text-center text-white">
          We&rsquo;ve got{" "}
          <span className="italic font-normal" style={serif}>
            answers
          </span>
        </h2>
      </FadeInUp>
      <FadeInUp delay={100}>
        <div className="border border-white/10 rounded-xl bg-transparent">
          {faq.map((item, i) => (
            <FaqItem
              key={item.question}
              item={item}
              last={i === faq.length - 1}
              open={openIndex === i}
              onToggle={() => setOpenIndex(openIndex === i ? null : i)}
            />
          ))}
        </div>
      </FadeInUp>
    </section>
  );
}

/* ── 7 · Footer ───────────────────────────────────────────────────────── */
const FOOTER_COLUMNS: {
  title: string;
  links: { label: string; href: string }[];
}[] = [
  {
    title: "Product",
    links: [
      { label: "Docs", href: DOCS_URL },
      { label: "Library", href: "/library" },
      { label: "Playground", href: PLAYGROUND_URL },
      { label: "Compare", href: COMPARE_URL },
    ],
  },
  {
    title: "Source",
    links: [
      { label: "GitHub", href: GITHUB_URL },
      { label: "npm", href: NPM_URL },
      { label: "Docker Hub", href: "https://hub.docker.com/r/salahpichen/heddle" },
      { label: "MIT licence", href: `${GITHUB_URL}/blob/main/LICENSE` },
    ],
  },
  {
    title: "Standard",
    links: [
      { label: "Agent Spec", href: "https://oracle.github.io/agent-spec/" },
      { label: "Getting started", href: "/docs/getting-started" },
      { label: "CLI reference", href: "/docs/cli-reference" },
      { label: "Server", href: "/docs/server" },
    ],
  },
];

function Footer() {
  return (
    <footer
      id="contact"
      className="relative z-0 pt-32 pb-10 px-6 border-t border-white/5 overflow-hidden scroll-mt-16"
    >
      <video
        className="absolute inset-0 object-cover w-full h-full opacity-40 -z-10"
        src={HERO_VIDEO}
        autoPlay
        muted
        loop
        playsInline
      />
      <div className="absolute inset-0 -z-10 bg-gradient-to-b from-black via-black/60 to-black" />

      <FadeInUp className="flex flex-col items-center text-center mb-32">
        <h2 className="text-4xl md:text-5xl font-semibold tracking-tight mb-8 text-white">
          One file. Runs{" "}
          <span className="italic font-normal" style={serif}>
            anywhere.
          </span>
        </h2>
        <div className="flex flex-row items-center gap-3">
          <GetStartedButton />
          <LearnMoreButton href="#features" />
        </div>
      </FadeInUp>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-8 max-w-7xl mx-auto mb-24">
        <div>
          <div className="flex items-center gap-2.5 text-white mb-4">
            <Logo />
            <span
              className="text-xl font-bold lowercase"
              style={{ fontFamily: "var(--font-mono)", letterSpacing: "0.02em" }}
            >
              heddle
            </span>
          </div>
          <p className="text-sm text-gray-400">Weave agents from spec.</p>
        </div>
        {FOOTER_COLUMNS.map((col) => (
          <div key={col.title}>
            <h3 className="text-sm font-medium text-white mb-4">{col.title}</h3>
            <ul className="space-y-3">
              {col.links.map((link) => (
                <li key={link.label}>
                  <a
                    href={link.href}
                    className="pl-footlink text-sm transition-colors"
                    {...(link.href.startsWith("http")
                      ? { target: "_blank", rel: "noreferrer" }
                      : {})}
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="flex flex-col md:flex-row justify-center items-center gap-4 text-xs text-gray-500 border-t border-white/5 pt-8 max-w-7xl mx-auto">
        <span>© 2026 heddle. All rights reserved</span>
        <span className="hidden md:inline" aria-hidden="true">
          ·
        </span>
        <span>
          Woven by <span className="text-gray-300">agents</span>
        </span>
        <span className="hidden md:inline" aria-hidden="true">
          ·
        </span>
        <span>
          Heddled by <span className="text-gray-300">humans</span>
        </span>
      </div>
    </footer>
  );
}

export default function Landing() {
  return (
    <div
      className="plety-landing bg-black text-white min-h-screen"
      style={{ fontFamily: "var(--font-sans)" }}
    >
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <NavBar />
      <main id="main">
        <Hero />
        <FeatureBundle />
        <FeatureChat />
        <FeatureNotes />
        <Faq />
      </main>
      <Footer />
    </div>
  );
}
