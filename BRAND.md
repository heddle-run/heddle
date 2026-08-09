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
- **Package:** `@heddle-run/cli` · **Binary:** `heddle` · **Tap:** `spichen/tap/heddle`
- **Server:** `@heddle-run/server` · **Binary:** `heddle-server`
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

## The design system

One vendored system now drives every page: the **Heddle design system**, in
`website/ds-heddle/`, from the "Heddle Design System" Claude Design project
(`2028ba65-c304-4d64-a4c6-09cbf88891be`). Three deviations from upstream are
recorded in `website/ds-heddle/DEVIATIONS.md` — read it before changing
anything under `ds-heddle/`. Its tokens are on `:root` and its element styles
on `body`, exactly as upstream ships them.

The site ran two systems for a while: FormFlow in `website/ds/` drove the
playground, compare and docs while the landing was rebuilt on Heddle, and the
Heddle tokens were scoped under a `.hds` wrapper so the two could coexist
without forty-two colliding property names. Both are gone — `ds/`, the `.hds`
wrapper, the `hd-*` helper classes, the FormFlow `Backdrop`, `lucide-react`
and the Inter font were all removed when the docs migrated. **If you find a
`--brand-pink`, a `--fs-xs`, a `--text-faint` or an `hd-` class anywhere, it is
a leftover and it resolves to nothing.** The pink accent is not part of this
brand.

heddle's own components live in `website/components/` and are built *from* the
vendored system — no site-specific code belongs inside `ds-heddle/`.

### The Heddle system, in one idea

Airy, light-first, Stripe-craft editorial: paper ground, navy ink, hairline
dividers between sections rather than background changes, and code always in
navy windows that stay dark in both themes. Inspired by the craft of Stripe's
marketing site and the restraint of Vercel's AI SDK page — inspiration only,
nothing copied.

**Loom, literalized (evolution on top of the above).** The warp-thread
metaphor stopped being a texture and became the landing page's actual
ground: a persistent Three.js loom — `components/weave-world/` — rendered
behind the whole page and driven by native scroll. `WeaveWorld.tsx` owns the
canvas, renderer and teardown, framing a fixed orthographic cover box (no
camera travel — a perspective dolly in an earlier build smeared geometry
across the near plane); `threadField.ts` builds the loom as a **ply of
three thick yarn ribbons** twisting around one shared cubic-bezier spine
that sweeps diagonally across the frame — each a GPU ribbon whose vertex
shader orbits it around the spine and whose fragment shader draws
spun-fiber striations, cylindrical shading, a silky sheen and depth-shadow
on the far side of the twist, so crossings occlude like a real braid. The
five `--gradient-thread` hues are spread across the three plies' colour
stops (no pink — retired with FormFlow). Scroll reaches the shader as two
uniforms: twist advance, and the **shed** — the orbit radius, so the ply
literally opens on the dark chapters and the weft tube (revealed by a
clipping plane at z = 0, between the front and back strands) passes through
the gap. `scrollConductor.ts` turns scroll into a fractional chapter number
keyed to the **viewport centre** (keyed to the top edge, a dark chapter
started fading while its own copy was still on screen); `chapters.ts` is
the keyframe ledger — drift, shed, weft, glow per section — including the
two chapters where the canvas itself turns navy (see Page composition). The
canvas follows the `html.dark` toggle live via a MutationObserver; the first
build hardcoded paper and painted the dark theme white.

`components/WeaveTexture.tsx` — the SVG plain weave with the checkerboard
over/under crossing — is still here, but demoted to the fallback ground: it
renders unconditionally one layer behind the canvas
(`components/weave-world/WeaveGround.tsx`, mounted in `app/layout.tsx`), and
is what no-JS, no-WebGL and `prefers-reduced-motion` users see. No section
mounts a `variant="strong"` instance any more; the sections stopped painting
their own woven surfaces when the world became live.

Ink deepened (`--navy-900` is `#081b2c`, not upstream's `#0a2540`) for more
contrast against paper, and shadows tightened from a soft Stripe float into
something closer to a printed edge — ink-tinted, not generic grey-blue. A
fixed, near-invisible grain overlay (`components/Grain.tsx`) gives the paper
actual tooth. Instrument Serif, upstream reserved for the dictionary
epigraph alone, now also carries two headline moments — Position's "The
specification is the program." and the CTA's "Thread the loom." — because
those two sentences are the closest thing the page has to a second pull
quote. The small hand-drawn SVG weave that used to sit beneath the epigraph
is retired: the Definition chapter is now the live loom's own close-up (the
camera pulls in and the real weft crosses the real warp behind the copy), so
the 2D miniature had become a duplicate — retiring it also removed the
landing page's gsap/ScrollTrigger usage. These are deviations from the
vendored `ds-heddle` tokens, applied at the site layer in `app/globals.css`
and `components/` (following the same override pattern already used there
for `--gradient-warp` and `--border-inverse`), not edits to `ds-heddle/`
itself.

### Palette

Ramps live in `ds-heddle/tokens/colors.css`; always use the semantic aliases,
never raw ramp values.

| Token | Value | Use |
|---|---|---|
| `--surface-page` | warm ivory `#faf7f0` (site override; upstream cloud-50) / black | Page ground |
| `--navy-900` | `#081b2c` (site override; upstream `#0a2540`) | Headings, code windows, dark bands |
| `--blurple-500` | `#635bff` | Primary accent, primary buttons |
| `--cyan-500` | `#00d4ff` | Secondary accent (CTA button on navy) |
| `--text-body` | slate-700 `#425466` / `#d4d4d4` | Prose |
| `--border-hairline` | cloud-200 / `#262626` | Section and list rules |

The loom's threads wear the **Meadow** palette — ivory, sage and camel
linen tones (`PLY_STOPS` in `components/weave-world/threadField.ts`, with a
soft shading profile tuned for those pastels), picked from a side-by-side
variants board over an all-`--gradient-thread` spread and a blurple/cyan
monochrome. The weft is navy ink on the light ground and candlelit gold on
the dark bands. `--gradient-thread` itself no longer appears anywhere. The
landing page's structural motif is the live loom (see above), with
`components/WeaveTexture.tsx` as its fallback ground; no section paints
its own woven surface any more. The world's surfaces track the theme: in
light, a vertical warm-ivory gradient `#fefdfa → #f7f4ed` with the navy
band `#081b2c`; in dark, flat black with the near-black band `#0f0f0f` —
kept in `chapters.ts` `palette()` because a WebGL ground cannot read a CSS
variable, and paired with the site-layer `--surface-page: #faf7f0`
override in `app/globals.css`; change the two files together.
**Always-dark surfaces use
`--surface-code`/`--surface-code-alt` (not `--surface-inverse`, which flips to
white in dark theme).** Shadows (`--shadow-xs` … `--shadow-lg`) are overridden
at the site layer to be tighter and ink-tinted (`rgba(8,27,44,…)`) rather than
upstream's softer, bluer-grey Stripe float.

### Type

**IBM Plex Sans** (300/400/500/600) for UI and display — display sizes set
Light with `--ls-display` tracking; **IBM Plex Mono** (400/500) for code,
commands, numbered eyebrows, stats and uppercase labels at `--ls-label`;
**Instrument Serif** for editorial moments — the dictionary definition and pull
quotes, and now also two headline moments on the always-dark bands, italic:
Position's "The specification is the program." and the CTA's "Thread the
loom." Both are the closest thing the page has to a second pull quote, which
is the bar for reaching for the serif outside the epigraph — it does not
belong on the numbered section headings, which stay Plex Sans Light. All
three load through `next/font/google` in `app/layout.tsx`
(deviation §2). Headings are sentence case and end in periods. Numbered mono
eyebrows mark the sections: `001 Inventory`, `002 Position`, …

### Geometry and depth

- Radii are small and precise: controls 5px, cards 10px, panels 12px, pills
  for badges. Nothing above 16px.
- Borders are 1px hairlines everywhere; sections divide by hairline, not by
  background swap.
- Shadows mostly none; cards `--shadow-xs` lifting to `--shadow-sm` on hover;
  the hero windows carry one large soft drop each. Never coloured glows.
  The shadow tokens themselves are tighter and ink-tinted at the site layer
  (see Palette) — a printed edge, not a soft Stripe float.
- Layout: 1180px container (`--maxw-container`), `--section-y` (112px) rhythm.
  Responsive grids are the `hds-*` classes in `globals.css` — media queries
  only; everything else styles inline from tokens.
- A fixed, pointer-events-none grain overlay (`components/Grain.tsx`, mounted
  once in `app/layout.tsx`) sits above everything at ~5% opacity: an inline
  SVG fractal-noise filter, alpha-composited rather than blend-moded, because
  `mix-blend-mode: overlay` does nothing over the dark theme's pure black.
- WebGL on this page has a history. A Stripe-style colourful graphic behind
  the old hero's code-window stack was tried three times — thin decorative
  threads, five blurred solid bands, then a gradient-mesh simplex shader —
  and pulled three times: each looked reasonable in the constrained,
  automated browser tab used to build it and wrong in a real one (the
  shader version rendered as a blurry, disconnected blob). The fourth
  attempt is the one that shipped, as `components/weave-world/`, and it
  survived because of two changes in kind, not degree: the shader draws
  *threads* — bounded ribbons with fibre, shading and occlusion — rather
  than a full-screen gradient wash, so there is nothing to smear; and every
  step was verified by eye in a real browser — which is what caught a
  camera dolly smearing geometry across the near plane (the camera is now a
  fixed orthographic frame), the dark theme painted white, and a dark
  chapter fading under its own copy. Keep that verification rule: never
  judge this canvas by forcing animation state via JavaScript in an
  automated tab and screenshotting the result — that method is what let
  three bad versions ship in a row.

### Motion

Fast and dry — 140–220ms on `--ease-standard`, fades and small translates, no
bounces. `prefers-reduced-motion` zeroes the duration tokens in
`ds-heddle/tokens/motion.css`.

The loom world is the one exception to "fast and dry": its camera, light and
shed interpolate continuously from native scroll (damped for rendering only —
the exact value drives nothing but pixels), with idle thread sway on top.
Scroll stays native and reversible: no Lenis, no scroll hijacking, no pinned
sections. Under `prefers-reduced-motion` the canvas never mounts and the
static `WeaveTexture` ground shows instead; the same fallback covers no-JS
and no-WebGL, so the canvas is atmosphere only and no content depends on it.

### Iconography

The system's `Icon` is self-contained inline SVG paths (1.5px stroke, round
caps, `currentColor`) in `ds-heddle/components/core/Icon.jsx` — no CDN, no
icon-font. It holds eleven glyphs drawn for a marketing page and takes no site
additions, so what the playground needs beyond them (run controls, a file
tree, the sun and moon) lives in `components/Glyph.tsx`: lucide paths on the
same 24 grid at the same stroke, indistinguishable beside it. Reach for `Icon`
first. Mono glyphs are legitimate icons in this brand: `⚙` for tool calls, `$`
prompts, `01`–`04` step numerals. There is no logo; the wordmark is the
lowercase word "heddle" set in Plex Sans Medium, which is all
`components/Wordmark.tsx` renders. No emoji, ever.

### Accessibility

- Focus is the soft blurple ring (`--ring-focus`), applied via
  `:focus-visible` in the system's base styles.
- A visible skip link opens the landing page.
- The FAQ uses native `<details>`, so it is keyboard-accessible without
  JavaScript.
- `prefers-reduced-motion` is honoured (above).

---

## Page composition

The landing page is one continuous walk through the loom world: nine
full-viewport chapters over the single persistent scene, in the kage manner —
the world changes state per chapter and the DOM floats over it. Each chapter
is a `components/landing/Chapter.tsx` wrapper (full-viewport `<section>` with
the id, centred content, and a full-width vertical scrim band in the
chapter's own surface colour — never an oval patch behind the copy; that was
tried and read as a floating blob in a real browser). **Three things are
ordered by the same list and must change together:** the `<Chapter>` sequence
in `app/page.tsx`, the keyframes in `components/weave-world/chapters.ts`, and
`CHAPTERS` in `components/landing/LandingChrome.tsx`.

`app/page.tsx` assembles, in order:

1. **LandingChrome** — the landing's own chrome, replacing the shared sticky
   Nav *on this page only* (`components/Nav.tsx` still serves /library and
   the 404): a fixed bar, transparent over the hero and paper-blurred once
   scrolled, with wordmark, a live mono chapter indicator ("002 · POSITION"),
   Docs / Library / Playground links, theme toggle and GitHub; plus the
   right-edge chapter rail — one dot per chapter, active one named and
   accent-coloured (blurple has contrast on both paper and the navy band,
   where `--text-strong` vanishes), click to jump. Hidden below 980px; the
   bar's chapter label carries wayfinding there.
2. **Hero** (`start`) — two beats in one chapter. First, a full viewport of
   centred display type: mono eyebrow, display-Light H1, the wedge sentence
   as lede, dual CTA, the Humans/Agents install tabs (from `installTabs`),
   and a scroll cue. Then the proof: the navy `flow.yaml` editor showing the
   real Open Agent Specification fragment from `steps[0]`, with the
   `zsh — heddle` terminal (from `specimenSpread.terminal`) overlapping it.
   `batteries-included` is one 18-character word, so the H1 clamp keeps its
   34px floor with `overflow-wrap: break-word` — check a 375px viewport
   before changing either.
3. **Inventory** (`included`) — 001. The full manifest as a numbered hairline
   list. **This section is what makes the lead claim falsifiable**, so every
   line has to name a feature that exists in the README — treat it the way
   `safeMode` is treated, and delete a line rather than let it drift. It is a
   list, not a card grid, because the claim is breadth and a reader should be
   able to count it. Two columns at desktop, one on mobile. The
   `notInProject` zeros no longer render here — the what-it-costs half of the
   claim is carried by the hero lede, Position and the CTA line.
4. **Position** (`position`) — 002, the page's first dark moment: the
   *world's canvas* turns navy for this chapter (the section paints no
   background of its own), the shed opens — the loom action the brand is
   named for — and the threads glow. The specification is the program, the
   refusal of the bigger-library trade, and the portability-off-heddle
   claim, beside a window showing the real `specimenSpread` spec.
5. **Method** (`method`) — 003, four hairline-divided moves: Declare, Point,
   Confine, Serve.
6. **Runtimes** (`runtimes`) — 004, on paper: the receipt for Position's
   "same equipment behind a binary" and for Method's Point/Serve moves. Two
   navy windows side by side, `runtimes.cli` and `runtimes.server` from
   `lib/constants.ts` — the identical flow, run locally and served over
   HTTP. Both transcripts are checked against `docs/cli-reference.mdx` and
   `docs/server.mdx`, not written to look plausible; update this section if
   either doc's example commands change.
7. **Isolation** (`isolation`) — 005, the sandboxing claims as four cards,
   verbatim from `safeMode` (see the security note above). The design's
   illustrative badges ("default in CI", "no daemon") were claims heddle
   does not make and must not return.
8. **Definition** (`definition`) — the dictionary epigraph, in Instrument
   Serif, at the loom's close-up: the camera pulls in and the world's weft
   crosses the warp behind the copy. (The 2D SVG mini-weave this section
   used to draw is retired — see the loom note above.)
9. **FAQ** (`faq`) — 006, native `<details>`; the world holds nearly still
   here so the dense text stays readable.
10. **CTA** (`begin`) — the finale: the canvas goes navy again, the shed
    opens widest on the page, and the weft completes its final pass.
    "Thread the loom.", accent Get started, ghost playground link, the npx
    command. Like Position, the section paints nothing — the world owns the
    band.
11. **Footer** — on its own solid `--surface-page` wrapper so the page ends
    on a real surface rather than the glowing world; brand blurb plus the
    Project / Source / Standard columns, and a mono bottom bar (heddle.run ·
    "Woven by agents, heddled by humans" · version). The byline leans on the
    Definition block above it having already taught the reader what a heddle
    does.

The Loom drawing, the bento Features grid and the Spread section from the
previous (FormFlow) landing page were retired earlier — the hero's
spec-beside-run windows carry what Spread carried. If a brand drawing
returns, it should be built in this system's warp-thread line language.

Copy and data live in `lib/constants.ts`; sections read from it rather than
hard-coding strings.

The section numbers are contiguous by hand, not computed. Adding or removing
a section means renumbering the ones after it — and keeping the three
chapter-ordered lists in sync (see above): the scroll conductor counts
`#main > section` elements, so a chapter added to the page but not to the
keyframe ledger shifts every world moment after it by one section.

The playground is not composed this way. It is an application: it fills the
viewport, carries its own bar and status bar instead of the site's nav and
footer, and has no numbered sections and no marketing copy. The wordmark in
the bar is the way back to the site, set the way the nav sets it. Two panes
scroll independently and the page itself does not scroll; below 900px they
stack and it does. Its layout classes are the `hds-playground*` and
`hds-compare*` sets in `globals.css`.

**The panes are the landing's navy code windows, given the whole screen.** The
rule that code is always navy does not stop being true because the page is an
application — the playground is mostly code, so paper is only the bar and the
status bar, and everything between them is a window inset on the page ground
with a 12px gutter. Inside a window: the tab strip is the hero's
`flow.yaml · tools/ · README` strip made selectable, `--surface-code-alt`
marking the one you are on; the body is `--surface-code`; every rule is
`--border-inverse`, never `--border-hairline`. **Cyan is the accent inside a
window and blurple is the accent on paper** — `--text-accent` has no contrast
against navy, and `--cyan-500` is what the system already puts on a dark
surface. The system's `Select`, `Input` and `IconButton` are paper controls
and read as holes punched in a window, so the inverse versions in
`components/playground/WindowControls.tsx` are what goes inside one, following
`IconButton`'s own `inverse` variant. Panes carry `color-scheme: dark` and
style their own scrollbars, because a light scrollbar drawn across the navy is
the one thing the tokens cannot reach.

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
a navy-black dark theme a toggle away. (Dark was the default before the
redesign; every page supports both now.) **next-themes is the single source
of truth**, configured
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

Next.js 15 (static export) · React 19 · one vendored design system in
`website/ds-heddle/`, styled with CSS custom properties and inline styles
rather than utility classes · Tailwind v4 retained **only** because fumadocs
needs it · fumadocs for `/docs`, remapped onto the system's tokens in
`globals.css`. Deployed to Cloudflare Pages.

`gsap` and `motion` (`motion/react`) drive the landing page's animation —
scroll reveals, the hero terminal's typed draw-in, the woven-thread motifs.
`three` was added and removed for a hero graphic that didn't work out (see
the note in Motion, above) — it is not a dependency of this site.

Layout helpers in `globals.css` are prefixed `hds-` and exist only for what
inline styles cannot express — media queries, `::placeholder`,
`::-webkit-scrollbar`, hover. Everything else uses the system's own tokens
directly.

### The docs shell

`/docs` is fumadocs, which draws its own chrome from Tailwind utilities bound
to `--color-fd-*`. Those are remapped onto the system's aliases at the top of
`globals.css`, and **that block is how the docs inherit the brand** — both
themes come free, because every alias on the right flips with `html.dark`. The
`#nd-*` rules under it are only the shape on top: hairline section rules above
each `h2`, mono uppercase for the sidebar groups and the table of contents,
navy code windows. They are the reason the tokens had to go back on `:root`:
Radix portals the search dialog and the mobile sidebar to `<body>`, where a
wrapper class cannot reach them.

Two fumadocs details are load-bearing. Its markup is not a stable interface,
so the selectors that catch the sidebar groups (`#nd-sidebar p`) and the
table-of-contents title (`#nd-toc h3`) were checked against the rendered tree
rather than guessed from utility classes — re-check them after a fumadocs
upgrade. And the TOC lives inside `#nd-page`, so its title rule has to come
*after* the `#nd-page` heading rules it ties with.

Both shiki themes in `source.config.ts` are `github-dark`, on purpose: fumadocs
would otherwise swap in a light theme with the site theme, and code is always
navy here.
