# heddle — brand and website brief

This file records the design system the website in `website/` is built to. Keep
it in sync when the site changes; it is the reference for anything new that has
to sit alongside it.

---

## Brand

- **Name:** heddle (always lowercase, including at the start of a sentence)
- **Domain:** heddle.run
- **Descriptor:** A batteries-included declarative agent runtime.
- **Tagline:** Weave agents from spec. (retained as the loom voice — it runs the
  `Definition` epigraph and the CTA badge, but it is no longer what the hero says)
- **Package:** `@heddle/cli` · **Binary:** `heddle` · **Tap:** `spichen/tap/heddle`
- **Server:** `@heddle/server` · **Binary:** `heddle-server`
- **Images:** `salahpichen/heddle` · `salahpichen/heddle-server` on Docker Hub,
  `ghcr.io/heddle-run/…` on GHCR. A Docker Hub namespace is an account name,
  and `heddle` there has belonged to someone else since 2019, so the Hub name
  carries a maintainer's. Use it where a reader is about to type it; use the
  GHCR name where the name is doing brand work, since it is the one that says
  heddle.

**The name.** A heddle is the part of a loom that lifts individual warp threads
to form the shed — the opening the weft passes through. It decides, thread by
thread, what the pattern becomes. That is the product thesis: the spec decides
what runs, the runtime just holds the threads. The dictionary entry appears
verbatim on the site as the pull quote, because the metaphor *is* the pitch.

**Voice.** Declarative, unhurried, faintly editorial. Short sentences. No
exclamation marks, no "blazing fast", no emoji. State what the thing does and
stop. British-leaning spelling in prose ("licence", "standardised"); American
in code and identifiers.

**The claim that leads.** heddle is a batteries-included declarative agent
runtime: the tool-calling loop, the sandbox, the HTTP server, the guardrails
and the retry policies ship with it rather than being left to the reader.

**The claim that must follow it immediately.** Both halves of that descriptor
are contested. "Declarative agent runtime" is what Docker Agent, Microsoft's
declarative workflows, Snap's Agent Format and Google's ADK all say; "batteries
included" is LangChain deepagents' actual subtitle and is claimed by Mastra,
AgentStart, the Microsoft Agent Framework and OpenClaw. So the descriptor
alone places heddle in a crowded room saying the same sentence as everyone
else, and it must never be left to stand on its own.

What separates heddle is that **every other batteries-included runtime is a
library, so its batteries arrive inside your codebase.** More complete means
more imported, pinned, upgraded and worked around. heddle is a runtime you
point at a document, so the same equipment costs the project nothing — zero
packages in the lockfile, zero classes to subclass, zero lines of glue. Say
this in the next breath after the descriptor, every time. The supporting
claims, in order: the flow is a portable Open Agent Specification document that
runs on any conforming runtime, and one document runs two ways, `heddle run` or
`heddle-server`, with no rewrite between them.

**Security copy is load-bearing.** The site makes falsifiable claims about
sandboxing. They live in `safeMode` in `lib/constants.ts` and are checked
against `packages/core/src/sandbox/` and `packages/server/DEPLOYMENT.md`. Never
soften, extend or round them up without re-reading those sources: state
mechanisms, not adjectives, and never write "enterprise-grade" or "bank-level".
Where a guarantee is conditional — `$VAR` resolution is refused for
caller-supplied specs but resolves for your own — say so rather than implying a
blanket promise.

---

## Design systems: Heddle (landing) and FormFlow (everything else)

The site is mid-migration between two vendored design systems, and the seam is
deliberate:

- **Heddle design system** — vendored into `website/ds-heddle/` from the
  "Heddle Design System" Claude Design project
  (`2028ba65-c304-4d64-a4c6-09cbf88891be`). The landing page and the 404 run on
  it. Four deviations from upstream are recorded in
  `website/ds-heddle/DEVIATIONS.md` — read it before changing anything under
  `ds-heddle/`. Its tokens are scoped under a `.hds` wrapper class so the two
  systems can coexist; the landing wraps itself in `<div className="hds">`.
- **FormFlow** — still vendored verbatim in `website/ds/`, still driving the
  playground, compare and docs (see `website/ds/DEVIATIONS.md`). Its dark
  near-monochrome hairline language and pink accent are unchanged there.
  Migrating those pages onto the Heddle system is open follow-up work; when it
  lands, `ds/` goes away and the `.hds` scoping can revert to `:root`.

heddle's own components live in `website/components/` and are built *from* the
vendored systems — no site-specific code belongs inside either `ds/` dir.

### The Heddle system, in one idea

Airy, light-first, Stripe-craft editorial: paper ground, navy ink, hairline
dividers between sections rather than background changes, and code always in
navy windows that stay dark in both themes. Inspired by the craft of Stripe's
marketing site and the restraint of Vercel's AI SDK page — inspiration only,
nothing copied.

### Palette

Ramps live in `ds-heddle/tokens/colors.css`; always use the semantic aliases,
never raw ramp values.

| Token | Value | Use |
|---|---|---|
| `--surface-page` | cloud-50 `#f6f9fc` / black | Page ground |
| `--navy-900` | `#0a2540` | Headings, code windows, dark bands |
| `--blurple-500` | `#635bff` | Primary accent, primary buttons |
| `--cyan-500` | `#00d4ff` | Secondary accent (CTA button on navy) |
| `--text-body` | slate-700 `#425466` / `#d4d4d4` | Prose |
| `--border-hairline` | cloud-200 / `#262626` | Section and list rules |

`--gradient-thread` (the multi-hue ribbon) appears only as thin rules — the
Definition underline — never as a fill. `--texture-warp` (1px warp-thread
lines at 32px pitch) may sit behind the inverse CTA band. Max two background
tints per page. **Always-dark surfaces use `--surface-code`/`--surface-code-alt`
(not `--surface-inverse`, which flips to white in dark theme).**

### Type

**IBM Plex Sans** (300/400/500/600) for UI and display — display sizes set
Light with `--ls-display` tracking; **IBM Plex Mono** (400/500) for code,
commands, numbered eyebrows, stats and uppercase labels at `--ls-label`;
**Instrument Serif** for editorial moments only — the dictionary definition and
pull quotes. All three load through `next/font/google` in `app/layout.tsx`
(deviation §3). Headings are sentence case and end in periods. Numbered mono
eyebrows mark the sections: `001 Inventory`, `002 Position`, …

### Geometry and depth

- Radii are small and precise: controls 5px, cards 10px, panels 12px, pills
  for badges. Nothing above 16px.
- Borders are 1px hairlines everywhere; sections divide by hairline, not by
  background swap.
- Shadows mostly none; cards `--shadow-xs` lifting to `--shadow-sm` on hover;
  the hero windows carry one large soft drop each. Never coloured glows.
- Layout: 1180px container (`--maxw-container`), `--section-y` (112px) rhythm.
  Responsive grids are the `hds-*` classes in `globals.css` — media queries
  only; everything else styles inline from tokens.

### Motion

Fast and dry — 140–220ms on `--ease-standard`, fades and small translates, no
bounces. `prefers-reduced-motion` zeroes the duration tokens in
`ds-heddle/tokens/motion.css`.

### Iconography

The system's `Icon` is self-contained inline SVG paths (1.5px stroke, round
caps, `currentColor`) in `ds-heddle/components/core/Icon.jsx` — no CDN, no
icon-font. Mono glyphs are legitimate icons in this brand: `⚙` for tool calls,
`$` prompts, `01`–`04` step numerals. There is no logo; the wordmark is the
lowercase word "heddle" set in Plex Sans Medium. No emoji, ever. (FormFlow
pages keep `lucide-react` through `ds/` — see its DEVIATIONS.md.)

### Accessibility

- Focus is the soft blurple ring (`--ring-focus`), applied via
  `:focus-visible` in the system's base styles.
- A visible skip link opens the landing page.
- The FAQ uses native `<details>`, so it is keyboard-accessible without
  JavaScript.
- `prefers-reduced-motion` is honoured (above).

---

## Page composition

`app/page.tsx` assembles, in order (everything inside the `.hds` wrapper):

1. **Nav** — sticky, paper-translucent, blurred; text wordmark, version pill,
   Docs / Spec / Playground links, mono theme-toggle button, GitHub
2. **Hero** — mono eyebrow, display-Light H1, the wedge sentence as lede, dual
   CTA, then the Humans/Agents install tabs (from `installTabs`). Beside it,
   the stacked windows: a navy `flow.yaml` editor showing the real Open Agent
   Specification fragment from `steps[0]`, with the `zsh — heddle` terminal
   (from `specimenSpread.terminal`) overlapping it. `batteries-included` is one
   18-character word, so the hero clamp is `34px…54px` with
   `overflow-wrap: break-word` — check a 375px viewport before changing either.
3. **Inventory** — 001. The full manifest as a numbered hairline list beside
   the four `notInProject` zeros. **This section is what makes the lead claim
   falsifiable**, so every line has to name a feature that exists in the README
   — treat it the way `safeMode` is treated, and delete a line rather than let
   it drift. It is a list, not a card grid, because the claim is breadth and a
   reader should be able to count it. Two columns at desktop, one on mobile;
   the design project's five-item sample was deliberately replaced with the
   whole manifest.
4. **Position** — 002, on the always-dark navy band: the specification is the
   program, the refusal of the bigger-library trade, and the
   portability-off-heddle claim, beside a window showing the real
   `specimenSpread` spec.
5. **Method** — 003, four hairline-divided moves: Declare, Point, Confine,
   Serve.
6. **Isolation** — 004, the sandboxing claims as four cards, verbatim from
   `safeMode` (see the security note above). The design's illustrative badges
   ("default in CI", "no daemon") were claims heddle does not make and must not
   return.
7. **Definition** — the dictionary epigraph, in Instrument Serif, over the
   thread-gradient rule.
8. **FAQ** — 005, native `<details>`.
9. **CTA** — the navy band with the warp texture: "Thread the loom.", accent
   Get started, ghost playground link, the npx command.
10. **Footer** — brand blurb plus the Project / Source / Standard columns, and
    a mono bottom bar (heddle.run · maintainer · version).

The Loom drawing, the bento Features grid and the Spread section from the
previous (FormFlow) landing page were retired with the redesign — the hero's
spec-beside-run windows now carry what Spread carried. If a brand drawing
returns, it should be built in this system's warp-thread line language.

Copy and data live in `lib/constants.ts`; sections read from it rather than
hard-coding strings.

The section numbers are contiguous by hand, not computed. Adding or removing a
section means renumbering the ones after it, and any nav link that points at
the anchor.

The playground is not composed this way. It is an application: it fills the
viewport, carries its own bar and status bar instead of the site's nav and
footer, and has no numbered sections and no marketing copy. The wordmark in
the bar is the way back to the site. Two panes scroll independently and the
page itself does not scroll; below 900px they stack and it does. Its layout
classes are the `hd-playground*` set in `globals.css`.

It is one page with two views, switched in the bar and carried in the address
as `?view=`. **Build** is the editor, the engine and the run log. **Compare**
is the same use case in heddle and in one other framework, side by side. They
were two pages until they merged, because they answer the same question in
sequence — is this better than what I already use, and does it actually run —
and because a comparison the reader cannot run is only an assertion. The
editor's state lives in `lib/use-playground.ts` rather than in the component,
so switching views and coming back does not throw a reader's spec away.

Build keeps exactly one piece of prose — the security paragraph about
submitted code and API keys, verbatim, in the status bar.

Compare pins heddle to the left pane; the picker in the bar chooses what fills
the right one. **Its credibility rests on the other columns being right**, so
treat competitor code as load-bearing in the same way security copy is. Each
column must be the shortest version that framework's own documentation would
write — never padded, never using a deprecated API where a current one is
nicer — and must be checked against that framework's current release before it
changes. The heddle specs in `lib/compare/heddle.ts` are checked with `heddle
validate`, and the guardrail and routing flows run end to end without a
credential; keep it that way. Every use case also names the playground example
that is its heddle column, and the button in that column loads it into the
editor: if those two drift apart, the offer is a lie. The ledger in the status
bar states countable facts only, and the closing line invites readers to
report anything unfair — honour that, or remove the line.

### Where it is served

The playground is `playground.heddle.run`. The site is one static export on
one Cloudflare Pages project, so the page is exported at `/playground` and
`website/functions/_middleware.js` serves that export at the subdomain's root
— Pages' `_redirects` matches paths, not hosts, which is the whole reason a
Function exists at all. `heddle.run/playground` keeps working; `/compare`
forwards to `?view=compare`.

Two things have to agree with that hostname or the playground loads and cannot
run: `ALLOWED_ORIGINS` in `packages/broker/wrangler.jsonc`, and `--cors-origin`
in `packages/server/k8s/deployment.yaml`. Both list an exact origin, never a
suffix. The subdomain itself is a custom domain on the Pages project, and
`vars.PLAYGROUND_URL` in the deploy workflow is what makes the site link to
it — unset, every link stays relative and nothing breaks.

## Theme

Light is the default since the Heddle system landed — it is light-first, with
a navy-black dark theme a toggle away. (Dark was the default in the FormFlow
era; the playground and docs support both, so they follow the site-wide
choice.) **next-themes is the single source of truth**, configured
on fumadocs' `RootProvider` in `app/layout.tsx` — fumadocs already runs it for
the `/docs` shell, so introducing a second theme system meant a toggle in the
docs sidebar that did nothing. It writes `class="dark"` on `<html>`, which is
exactly the hook the design system's tokens key on, and injects its own
pre-paint script so there is no flash.

`lib/theme.tsx` wraps it in a `useTheme()` that returns the `{ dark, toggle }`
shape the design system's `ThemeToggle` expects. Use that rather than reaching
for `next-themes` directly, and note that `<html>` needs
`suppressHydrationWarning` because the class is set before React hydrates.

Both themes are supported everywhere. Check both before shipping a change.

## Stack

Next.js 15 (static export) · React 19 · two vendored design systems —
`website/ds-heddle/` (landing, 404) and `website/ds/` (playground, compare,
docs) — both styled with CSS custom properties and inline styles rather than
utility classes · Tailwind v4 retained **only** because fumadocs needs it ·
fumadocs for `/docs`, remapped onto the FormFlow tokens in `globals.css` ·
`lucide-react` for icons on the FormFlow pages. Deployed to Cloudflare Pages.

Layout helpers in `globals.css` are prefixed `hd-` (FormFlow pages) and `hds-`
(Heddle landing) and exist only for what inline styles cannot express — media
queries. Everything else uses the systems' own tokens directly. The FormFlow
`Backdrop` renders only on FormFlow routes, gated by
`components/RouteBackdrop.tsx`.
