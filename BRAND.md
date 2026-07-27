# heddle — brand and website brief

This file records the design system the website in `website/` is built to. Keep
it in sync when the site changes; it is the reference for anything new that has
to sit alongside it.

---

## Brand

- **Name:** heddle (always lowercase, including at the start of a sentence)
- **Domain:** heddle.run
- **Tagline:** Weave agents from spec.
- **Package:** `@heddle/cli` · **Binary:** `heddle` · **Tap:** `spichen/tap/heddle`
- **Server:** `@heddle/server` · **Binary:** `heddle-server`
- **Images:** `heddle/heddle` · `heddle/heddle-server`

**The name.** A heddle is the part of a loom that lifts individual warp threads
to form the shed — the opening the weft passes through. It decides, thread by
thread, what the pattern becomes. That is the product thesis: the spec decides
what runs, the runtime just holds the threads. The dictionary entry appears
verbatim on the site as the pull quote, because the metaphor *is* the pitch.

**Voice.** Declarative, unhurried, faintly editorial. Short sentences. No
exclamation marks, no "blazing fast", no emoji. State what the thing does and
stop. British-leaning spelling in prose ("licence", "standardised"); American
in code and identifiers.

**The claim that leads.** heddle needs no SDK. Other agent frameworks are
libraries — you install them, import them, and assemble the graph in code, so
the agent ends up depending on their abstractions. heddle inverts that: the
flow is a document you write, and heddle is a runtime you point at it. Say this
before saying anything about features. The second claim is that one document
runs two ways, `heddle run` or `heddle-server`, with no rewrite between them.

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
   commands, capability chips, then the **Loom** inside a boxed frame
3. **Loom** (`components/Loom.tsx`) — nine warp threads lifted by four heddle
   frames and converging into a single mark, the active thread in accent. It is
   simultaneously the brand drawing and the execution pipeline: parse →
   validate → compile → run
4. **Manifesto** — 001, the no-SDK position
5. **Steps** — 002, three step cards, each over its own code fragment
6. **Stats** — four countable claims in a boxed frame
7. **Features** — 003, bento: one tall cell plus five tiles
8. **SafeMode** — 004, the sandboxing claims (see the security note above)
9. **Spread** — 005, the document beside the run, in two window-chromed panels
10. **Definition** — the dictionary epigraph
11. **FAQ** — 006, native `<details>`
12. **CTA** — boxed frame, install commands
13. **Footer** — four columns under a hairline

`/playground` continues the numbering at 007 and 008. Copy and data live in
`lib/constants.ts`; sections read from it rather than hard-coding strings.

The section numbers are contiguous by hand, not computed. Adding or removing a
section means renumbering the ones after it, the `/playground` pair, and any
nav link that points at the anchor.

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
