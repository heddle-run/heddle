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

## Design system: FormFlow

The site is built on the **FormFlow design system**, vendored verbatim into
`website/ds/`. Three deliberate deviations from upstream are recorded in
`website/ds/DEVIATIONS.md` — read it before changing anything under `ds/`.

The seam matters: `ds/` is the vendored system and holds nothing
heddle-specific, so upstream updates stay mergeable. heddle's own components
live in `website/components/` and are built *from* it.

Its one-idea summary: a near-monochrome neutral interface, dark by default,
drawn almost entirely in 1px hairlines, with exactly one saturated colour used
as an *instrument* — never as a fill.

### Palette

The chassis is the Tailwind neutral ramp, `--neutral-50` … `--neutral-950`.
Dark pages sit on `#0a0a0a`, light on `#fafafa`. Semantic aliases resolve per
theme; always use those rather than a raw ramp value.

| Token | Value | Use |
|---|---|---|
| `--brand-pink` | `#ff005e` | The single accent |
| `--bg-page` | neutral-950 / neutral-50 | Page ground |
| `--text-strong` | white / neutral-900 | Headings, emphasis |
| `--text-body` | neutral-400 / neutral-600 | Prose |
| `--border-default` | white 10% / neutral-200 | Hairlines |

**The accent is an instrument.** Pink appears as corner ticks and 1px rules,
border tints at 20–50% alpha, badge fills at 5%, focus rings, the active loom
thread, tool-call lines in a run log, and text selection. It is **never** a
button fill: primary buttons are `neutral-900` on light and white on dark, with
inverted labels. A secondary palette of hues (purple, blue, emerald, amber,
rose) exists only for per-word heading hovers and small icon accents — never as
backgrounds.

### Type

**Inter, and only Inter**, in weights 300/400/500/600, loaded through
`next/font/google`. A system monospace stack is reserved for code, commands,
numeric readouts and micro-labels — nothing else.

Headings are Medium (hero) or Semibold (sections) with negative tracking:
`-0.05em` at hero scale, `-0.025em` elsewhere. Hero line-height 1.1, body 1.5,
long paragraphs 1.625. UI default 14px; labels 12px; micro-uppercase 10px at
`0.1em`.

### Geometry and depth

- **There is a radius scale**, and it is used: 4px chips · 8px inputs and
  in-product buttons · 12px windows and code blocks · 16px cards · fully round
  for marketing CTAs and badges. The previous system enforced radius 0 globally
  with an `!important` rule; that is gone, and should not be reintroduced.
- **Borders are 1px by default.** 2px marks selected and featured states only.
- **Shadows are sparse and soft.** Cards get none; floating things — the
  playground window, the spec/run panels — get a large diffuse shadow, tinted
  pink rather than black in dark mode.

### The signature motif — the boxed frame

Content blocks are marked out by 20px pink L-shaped corner ticks plus hairline
rules that extend `100vw`/`100vh` past the block, fading at both ends. Use
`BoxedFrame`; it is the most recognisable thing in the system. Because those
rules overhang the viewport, `body` keeps `overflow-x: hidden` — do not remove
it.

### Backdrop

Three fixed layers at z-0, always together, rendered once in the root layout
via `Backdrop`: blurred conic-gradient swirls that rotate and drift; a 50px
hairline grid; a fractal-noise film at 3%. Page content rides above at z-10
(`.hd-content`). The atmosphere is entirely procedural — there is no
photography, illustration or stock imagery anywhere, and none should be added.

### Motion

Slow, looping, low-amplitude. Entrances are `fade-in-up`: a 20px rise over
800ms on `cubic-bezier(.16,1,.3,1)`, staggered in 100ms steps. Loops run
3–26s. Colour transitions are 300ms. `prefers-reduced-motion` is honoured
globally in `globals.css` — animations are held still, and the swirls and beam
runners are removed outright.

### Iconography

**Lucide**, delivered through `lucide-react` and resolved from an explicit
registry in `ds/components/core/Icon.jsx`. Outline only, 24px grid, round caps,
no fills. Adding a glyph means importing it and adding it to `REGISTRY` — an
unregistered name throws in development rather than rendering an empty box.
Never substitute another icon set, and never hand-draw SVGs. The loom is the
one bespoke drawing, and it is a diagram, not an icon.

### Accessibility

- Focus is a 2px `--brand-pink` outline at 2px offset, everywhere.
- A visible skip link opens the page.
- Touch targets stay at 44px or larger.
- `prefers-reduced-motion` is honoured (above).
- The FAQ uses native `<details>`, so it is keyboard-accessible without
  JavaScript.

---

## Page composition

`app/page.tsx` assembles, in order:

1. **Nav** — sticky, translucent, blurred; wordmark, links, theme toggle, CTA
2. **Hero** — version badge, per-word hero, sub-copy, dual CTA, install
   commands, capability chips, then the **Loom** inside a boxed frame. Only the
   four content words take a hover hue; the leading article is set plainly.
   `batteries-included` is one 18-character word, so the hero clamp is
   `34px…72px` with `overflow-wrap: break-word` — check a 375px viewport before
   changing either.
3. **Loom** (`components/Loom.tsx`) — nine warp threads lifted by four heddle
   frames and converging into a single mark, the active thread in accent. It is
   simultaneously the brand drawing and the execution pipeline: parse →
   validate → compile → run
4. **Manifest** — 001, the inventory. Twelve batteries as a checklist, over a
   boxed frame of four zeros counting what they add to the reader's project.
   **This section is what makes the lead claim falsifiable**, so every line has
   to name a feature that exists in the README — treat it the way `safeMode` is
   treated, and delete a line rather than let it drift. It is a list, not a card
   grid, because the claim is breadth and a reader should be able to count it.
   The `.hd-manifest` grid is sized to leave whole rows: three columns of four
   wide, two of six at tablet width. Twelve is load-bearing for that.
5. **Manifesto** — 002, the position: batteries-included usually means a bigger
   library, and why heddle does not make that trade
6. **Steps** — 003, three step cards, each over its own code fragment
7. **Features** — 004, bento: one tall cell plus five tiles. Depth on the
   handful that are hard to copy, where the Manifest is breadth — the tall cell
   is the batteries-outside-your-codebase argument.
8. **SafeMode** — 005, the sandboxing claims (see the security note above)
9. **Spread** — 006, the document beside the run, in two window-chromed panels
10. **Definition** — the dictionary epigraph
11. **FAQ** — 007, native `<details>`
12. **CTA** — boxed frame, install commands
13. **Footer** — four columns under a hairline

There is no longer a standalone Stats band; its four numerals were folded into
the Manifest, where the contrast between what is included and what it costs
lands in one eyeful instead of two scrolls apart.

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

Dark is the default. **next-themes is the single source of truth**, configured
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

Next.js 15 (static export) · React 19 · the vendored design system in
`website/ds/`, styled with CSS custom properties and inline styles rather than
utility classes · Tailwind v4 retained **only** because fumadocs needs it ·
fumadocs for `/docs`, remapped onto the design system's tokens in
`globals.css` · `lucide-react` for icons. Deployed to Cloudflare Pages.

Layout helpers in `globals.css` are prefixed `hd-` and exist only for what
inline styles cannot express — media queries. Everything else uses the system's
own tokens directly.
