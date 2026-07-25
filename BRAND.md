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

**The name.** A heddle is the part of a loom that lifts individual warp threads
to form the shed — the opening the weft passes through. It decides, thread by
thread, what the pattern becomes. That is the product thesis: the spec decides
what runs, the runtime just holds the threads. The dictionary entry appears
verbatim on the site as the pull quote, because the metaphor *is* the pitch.

**Voice.** Declarative, unhurried, faintly editorial. Short sentences. No
exclamation marks, no "blazing fast", no emoji. State what the thing does and
stop. British-leaning spelling in prose ("licence", "standardised"); American
in code and identifiers.

---

## Design system: Minimalist Monochrome

Editorial luxury, not developer-tool-template. The reference points are fashion
magazine covers, gallery catalogues and fine book design — not SaaS landing
pages.

### Palette — absolute

| Token | Value | Use |
|---|---|---|
| `paper` | `#FFFFFF` | Background |
| `ink` | `#000000` | Text, borders, and the accent |
| `muted` | `#F5F5F5` | Subtle fills |
| `muted-ink` | `#525252` | Secondary text |
| `hairline` | `#E5E5E5` | Quiet dividers |

There is no other colour. Emphasis is created by **inverting** a section to
black, never by introducing a hue. Syntax highlighting in the docs is passed
through `grayscale(1) contrast(1.35)` so token contrast survives without colour.

### Type

- **Display:** Playfair Display — headlines, numerals, the wordmark
- **Body:** Source Serif 4 — prose
- **Mono:** JetBrains Mono — labels, metadata, code, section numbers

Labels are uppercase with `tracking-[0.2em]`. Headlines are `tracking-tight` or
tighter. At least one word on the page is set at `8xl`–`9xl`; on the landing
page that word is *Weave*.

### Geometry and depth

- **Border radius: 0 everywhere.** Enforced globally in `globals.css` so
  third-party components cannot reintroduce pills.
- **No shadows.** Depth comes from inversion, border weight and negative space.
- Section dividers are 4px black rules; the footer opens with an 8px rule.
- Rule weights: hairline 1px grey · thin 1px black · medium 2px · thick 4px ·
  ultra 8px.

### Texture

Flat is a failure mode. Every major section carries one or two overlays from
`components/ui/Texture.tsx`: `warp` (vertical threads, the brand motif), `lines`,
`grid`, `diagonal`, `noise`, and the inverted `warp-inverted` /
`radial-inverted` for black bands.

### Motion

Minimal and instant. Transitions are 100ms or absent. Hover on cards, features
and specimens performs a full colour inversion. The FAQ uses native `<details>`
so the state change is immediate and keyboard-accessible without JavaScript.
There is no scroll animation, parallax or reveal.

### Accessibility

- Black on white is 21:1.
- `focus-visible` outlines: 3px solid black, 3px offset on buttons, 2px on
  secondary controls.
- A visible black skip link opens the page.
- Touch targets stay at 44px or larger.

---

## Page composition

`app/page.tsx` assembles, in order:

1. **Nav** — sticky, wordmark plus `.run` in mono, thin black rule beneath
2. **Hero** — oversized italic *Weave*, thick rule with a bordered square,
   install commands, then the **Loom** band
3. **Loom** (`components/Loom.tsx`) — nine warp threads lifted by four heddle
   frames and converging into a single mark. It is simultaneously the brand
   drawing and the execution pipeline: parse → validate → compile → run
4. **Manifesto** — 001, boxed drop cap
5. **Steps** — 002, three inverting cards
6. **Stats** — inverted black band, vertical thread texture
7. **Features** — 003, six-cell bordered grid
8. **Specimens** — 004, four sample flows as catalogue plates
9. **Spread** — 005, the document on white beside the run on black
10. **Definition** — the dictionary epigraph
11. **FAQ** — 006
12. **CTA** — inverted, radial texture
13. **Footer** — mono columns under an 8px rule

Copy and data live in `lib/constants.ts`; sections read from it rather than
hard-coding strings.

---

## Stack

Next.js 15 (static export) · React 19 · Tailwind v4 (`@theme` tokens in
`app/globals.css`) · fumadocs for `/docs`, themed onto the same tokens ·
lucide-react at `strokeWidth={1.5}`. Deployed to Cloudflare Pages.
