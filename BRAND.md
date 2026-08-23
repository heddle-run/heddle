# heddle — brand and website brief

This file records the design system the website in `website/` is built to. Keep
it in sync when the site changes; it is the reference for anything new that has
to sit alongside it.

---

## Brand

- **Name:** heddle (always lowercase, including at the start of a sentence)
- **Domain:** heddle.run
- **Descriptor:** A batteries-included declarative agent runtime.
- **Tagline:** Weave agents from spec. (it is the footer brand line now — the
  loom voice's one surviving sentence on the landing page)
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
what runs, the runtime just holds the threads. The metaphor survives the 2026-08
redesign in two places: the stroke-drawn logo (three warp threads, one weft
passing over and under) and the footer's bottom bar ("Woven by agents · Heddled
by humans"). The dictionary epigraph no longer appears on the landing page.

**Voice.** Declarative, unhurried, faintly editorial. Short sentences. No
exclamation marks, no "blazing fast". State what the thing does and stop.
British-leaning spelling in prose ("licence", "standardised"); American in code
and identifiers. One scoped exception since the redesign: the ✨ sparkle that
opens the hero badge and the two feature eyebrows — it is part of the vendored
badge pattern, appears nowhere else, and is the only emoji on the site.

**The audience the landing page addresses.** Technically confident
non-developers: IT and ops people, analysts, automation builders who have hit
the ceiling of Zapier or n8n, serious hobbyists. They can open a terminal,
paste a command and edit a YAML file; they do not write programs, have not
heard of LangGraph, and do not experience dependency trees as pain. The
landing page's comparison class is therefore doing the job by hand, a chat
window, or a fixed-rule Zapier flow — **not** other agent frameworks. Its
rules: at most one unexplained term per screen; outcome-first headings;
prerequisites, cost and data-handling stated plainly (the FAQ carries these
now); an early-release marker visible in the hero — it lives in the badge
("✨ Early release — …"), and there is still no version number anywhere in the
app (removed deliberately). The H1 keeps the descriptor — "A
batteries-included declarative agent runtime." was chosen deliberately in
2026-08 and survived the Plety redesign, with "runtime." as the serif italic
accent word — and the lede beneath it is the descriptor's plain-language
translation, which is what carries the page for the non-developer reader.

**The claim for developers still exists — it just moved.** heddle is a
batteries-included declarative agent runtime, and both halves of that
descriptor are contested ("declarative agent runtime" is what Docker Agent,
Microsoft's declarative workflows and Google's ADK all say; "batteries
included" is LangChain deepagents' actual subtitle). What separates heddle is
that **every other batteries-included runtime is a library, so its batteries
arrive inside your codebase**; heddle is a runtime you point at a document,
so the same equipment costs the project nothing. That argument now lives in
the docs (getting-started keeps it) and in the playground's compare view —
wherever it appears, never let the descriptor stand without the
runtime-vs-library wedge in the next breath. On the landing page the same
facts surface in this reader's terms: the hero lede's "one free, open-source
program on your own computer" and "an open format you are not locked into".

**Security copy is load-bearing.** The site makes falsifiable claims about
sandboxing. They live in `safeMode` in `lib/constants.ts` and are checked
against `packages/core/src/sandbox/` and `packages/server/DEPLOYMENT.md`. Never
soften, extend or round them up without re-reading those sources: state
mechanisms, not adjectives, and never write "enterprise-grade" or "bank-level".
Where a guarantee is conditional — `$VAR` resolution is refused for
caller-supplied specs but resolves for your own — say so rather than implying a
blanket promise. The landing FAQ quotes `faqItems` verbatim for the same
reason; translate language there, never claims.

---

## The design system

Two layers drive the site:

- The vendored **Heddle design system** in `website/ds-heddle/` still supplies
  the tokens, element styles and components the docs shell, library pages and
  playground are built from. Its deviations from upstream are recorded in
  `website/ds-heddle/DEVIATIONS.md` — read it before changing anything under
  `ds-heddle/`. No site-specific code belongs inside `ds-heddle/`.
- The **Plety look** (adopted 2026-08 from a reference design the user
  supplied, brand-named "Plety" in the prompt): a sleek, pure-black,
  monochrome aesthetic in the Untitled-UI/Linear register. It is the brand's
  look now. The landing page implements it directly in Tailwind utilities;
  the rest of the site inherits it through the dark theme, which became the
  default, plus a small monochrome override block at the end of
  `app/globals.css`.

The loom world is gone. The Three.js ply (`components/weave-world/`), the SVG
plain weave (`WeaveTexture`), the grain overlay, the chapter rail, the ivory
ground and the Meadow-accented light-first look were all retired with the
redesign; `three`, `gsap` and `motion` left `package.json` with them. The
light theme survives only as the docs shell's toggle, still wearing the old
ivory/sage palette — pure black is the brand, light is the courtesy.

### The Plety look, in one idea

Pure black ground (`bg-black`, `#000`), white display type, `gray-400` prose,
hairline rules at `white/10`, controls as pills. Depth comes from translucency,
not shadow: glass surfaces (`bg-black/80 backdrop-blur-md` nav,
`bg-[#1C1C1E]/90 backdrop-blur-xl` floating cards) over ambient background
video, with gradient scrims keeping text legible. Every display headline
carries exactly one serif italic accent word. Motion is one gesture: FadeInUp —
sections slide up 40px from transparent over 1000ms as they enter the
viewport.

### Palette

The landing page states these directly as Tailwind utilities; the equivalent
dark-theme tokens (for pages built from `ds-heddle/`) are noted beside them.

| Use | Landing (Tailwind) | Token equivalent (dark theme) |
|---|---|---|
| Page ground | `bg-black` | `--surface-page` `#000000` |
| Display type, emphasis | `text-white` | `--text-strong`, `--text-accent` `#ffffff` |
| Prose | `text-gray-400` | `--text-muted` |
| Quiet labels, marquee | `text-gray-500` | `--text-subtle` |
| Hairlines | `border-white/10` (quieter: `white/5`) | `--border-hairline` `#262626` |
| Raised control | `bg-[#1F1F22]`, hover `#2A2A2D` | `--surface-accent-soft` `#1f1f22` |
| Glass card | `bg-[#1C1C1E]/90 backdrop-blur-xl border-white/10` | — |
| Primary action | white bg, black text | `--action-primary-bg/fg` |
| Feature eyebrows | `text-yellow-200`, `text-green-300` | — (the two permitted tints) |

The accent is monochrome: emphasis is white, links are the body grey
brightening to white on hover. The `html.dark` override block at the end of
`app/globals.css` is what neutralises the sage the Meadow ramps would
otherwise route into `--text-accent`, links and the focus ring. The Meadow
ramps themselves (sage/camel over ivory) still exist for the legacy light
theme; do not extend them to anything new.

### Type

Three roles, assigned by rule rather than by feel — unchanged by the redesign:

- **Structural — Archivo** (variable, width axis): headings, nav, buttons,
  labels — the page's own furniture. The landing sets `var(--font-sans)` on
  its root and Tailwind weights on top: display headlines `font-medium
  tracking-tight` (hero `text-5xl md:text-7xl`), section heads
  `text-4xl md:text-5xl font-semibold`, controls `text-sm font-medium`.
- **Human — Newsreader** (variable, true italic): the serif italic accent
  word inside each display headline (`var(--font-serif)`, `italic
  font-normal`) — one word per headline, usually the last. In the docs it
  remains the prose default via `--font-body`.
- **Machine — Commit Mono**: only where text is genuinely machine-read or
  machine-written — commands, filenames, YAML, transcripts — and the
  wordmark. Ligatures off in code, on in prose.
- **Gentium Plus** remains loaded for the docs; the landing no longer shows
  the IPA line.

All load self-hosted through `next/font` in `app/layout.tsx` (deviations §2
and §4). The docs type scale in `globals.css`'s type-system block is
unchanged. Headings are sentence case; the landing's display headlines drop
the trailing period in favour of the serif accent word carrying its own.

The wordmark is the lowercase word "heddle" set in the machine face at
+0.02em — the one place mono is furniture, on purpose. Since the redesign it
is paired with the logo (below) in the landing nav and footer.

### The logo

There is a logo now — the first this brand has had: a stroke-drawn heddle on
a 28-grid, `fill="none" stroke="currentColor"` at 1.5px with round caps —
three vertical warp threads and one weft path crossing them. It lives as
`Logo` inside `components/landing/Landing.tsx` and is drawn in the same
stroke language as every icon on the page (Untitled-UI register: minimal,
geometric, single-weight). Use it beside the wordmark, never instead of it.

### Geometry and depth

- Pills for every control (`rounded-full`); cards `rounded-2xl`; mockup
  frames `rounded-3xl`; the FAQ container `rounded-xl`. The old small-radius
  rule (5/10/12px) still governs `ds-heddle`-built pages.
- Borders are 1px hairlines at `white/10` (structural) or `white/5`
  (quieter: nav button, footer rules). Sections divide by hairline or by
  nothing — never by background swap; the ground is always black.
- No shadows on the landing. Depth is translucency + backdrop-blur over
  video, with gradient scrims (`from-black/30 via-transparent to-black` on
  the hero, `from-black via-black/60 to-black` on the footer) keeping copy
  legible.
- Layout: `max-w-7xl mx-auto px-6` is the landing container; the FAQ narrows
  to `max-w-3xl`. `ds-heddle` pages keep `--maxw-container`.
- Background video: three ambient loops from `cdn.sceneai.art`, absolutely
  positioned behind content (`-z-10` full-bleed in hero and footer,
  `absolute inset-0 object-cover` inside the feature mockup frames), always
  `autoPlay muted loop playsInline`, always under a scrim or `bg-black/20`
  overlay. Video is atmosphere only; no content depends on it.

### Motion

One gesture, used everywhere: **FadeInUp** (in `Landing.tsx`) — opacity 0 →
1, translate-y 40px → 0, 1000ms ease-out, triggered once per element by
IntersectionObserver, with small stagger delays (0/100/150ms) between a
section's text and its mockup. Everything else is fast and dry: 300ms for
the nav glass, mobile menu, FAQ accordion and plus-to-close rotation;
`transition-colors` on hovers. The marquee is the only loop: a 30s linear
`marquee` keyframe (defined in `globals.css`) sliding a `w-max` flex row by
exactly −25% — four identical groups, so the loop closes seamlessly — behind
a `mask-image` edge fade. `html { scroll-behavior: smooth }` carries anchor
navigation. `prefers-reduced-motion` zeroes all of it via the global rule in
`globals.css`; no scroll hijacking, no pinned sections, ever.

The FAQ accordion animates height with the grid trick —
`grid-template-rows: 0fr → 1fr` on a wrapper with an `overflow-hidden`
child — because height: auto cannot transition.

### Iconography

Inline stroke SVG only: 24-grid, 1.5px, round caps, `currentColor` — the
logo, the hamburger, the mic and soundwave, the play button, the FAQ plus,
the marquee platform glyphs are all drawn this way in `Landing.tsx`. The
system's `Icon` (`ds-heddle/components/core/Icon.jsx`) and
`components/Glyph.tsx` still serve the `ds-heddle`-built pages. Mono glyphs
(`⚙`, `$`, step numerals) remain legitimate icons. The ✨ badge sparkle is
the single emoji exception recorded under Voice.

### Honesty rules the design must keep

- **The marquee names platforms, never customers.** "Runs where you already
  work" — macOS, Linux, Docker, Kubernetes, npx — is a checkable claim. The
  reference design's "Trusted by industry leaders" over invented brand names
  is exactly the kind of fake social proof this site does not do.
- **Mock UI states only what the product does.** The chat card mirrors
  `heddle chat`; the notetaker card (play, timestamp, waveform, transcript)
  mirrors `library/local-notetaker`, and its feature copy is the `useCases`
  detail line quoted, not embellished. The FAQ quotes `faqItems` verbatim.

### Accessibility

- Focus stays visible: `--focus-ring` is a neutral grey on black (overridden
  in the dark block of `globals.css`), applied via `:focus-visible`.
- A visible skip link opens the landing page.
- The FAQ accordion is a real `<button>` with `aria-expanded`; the mobile
  menu button carries `aria-expanded` and a state-dependent label.
- `prefers-reduced-motion` is honoured (above). The scroll reveal's only
  cost under it is an instant appearance.
- Marquee repeats are `aria-hidden` past the first group.

---

## Page composition

The landing page is a single file — `components/landing/Landing.tsx`
(`"use client"`), rendered by the server wrapper `app/page.tsx` so the
layout's metadata applies. Single-file is deliberate, from the reference
prompt: the FadeInUp wrapper, the nav, every section and the logo live
together. Checkable copy still comes from `lib/constants.ts` (the FAQ picks
five `faqItems` by question string; the notetaker copy quotes `useCases`).
Six sections, in order:

1. **Nav** — fixed, `z-50`, transparent until 20px of scroll then
   `bg-black/80 backdrop-blur-md` (also when the mobile menu is open).
   Logo + wordmark left; About / Features / FAQ / Contact centred
   (`text-sm font-medium text-gray-300 hover:text-white`), anchoring to the
   section ids; a pill "Get started" (`bg-[#1F1F22]` …) right, linking to
   /docs. Below `md`: hamburger, height-animated dropdown, links close it
   on tap.
2. **Hero** (`id="about"`) — `min-h-screen`, centred, over the ambient
   video (opacity-90) under a `from-black/30 via-transparent to-black`
   scrim. Badge pill ("✨ Early release — now with an agent library"), the
   descriptor H1 with "runtime." in serif italic, the plain-language lede
   at exactly `text-[16px] text-gray-400`, then white "Get started" and
   dark "Learn more" pills. `mt-24` below: the platform marquee ("Runs
   where you already work").
3. **Feature: interactive chat** (`id="features"`) — two columns
   (`lg:grid-cols-2 gap-16 py-24`), text left / mockup right. Yellow
   eyebrow, headline with serif "conversation.", session-transcript copy,
   "Get started". The mockup is a `rounded-3xl` video frame with a glass
   chat card: suggestion chips, "Ask anything..." input, mic and soundwave
   strokes.
4. **Feature: local notetaker** — mirrored (mockup left, text right; the
   mockup drops below the text on mobile via `order-last lg:order-first`).
   Green eyebrow, headline with serif "machine.", the `useCases` detail
   quoted. Card: play button, "11:06 AM – Chris", waveform bars, a dummy
   transcript line.
5. **FAQ** (`id="faq"`) — `max-w-3xl`, centred "We've got answers" with
   serif "answers", one transparent `border-white/10 rounded-xl` container,
   five real questions (`border-b` between items, none after the last),
   plus-rotates-to-close, grid-rows height animation. First item open by
   default.
6. **Footer** (`id="contact"`) — the same hero video at opacity-40 under a
   strong `from-black via-black/60 to-black` scrim. Centred CTA "Ready to
   automate everything?" with serif italic "everything?", the two pills,
   `mb-32`; then the four-column link grid (brand + "Weave agents from
   spec." / Product / Source / Standard), `mb-24`; then the bottom bar —
   "© 2026 heddle. All rights reserved · Woven by agents · Heddled by
   humans", the words "agents" and "humans" one step brighter
   (`text-gray-300`).

Anchor targets carry `scroll-mt-16` for the fixed nav. The shared
`components/Nav.tsx` and `components/Footer.tsx` still serve /library and
the 404 only; the landing's nav and footer are its own.

The playground is not composed this way. It is an application: it fills the
viewport, carries its own bar and status bar instead of the site's nav and
footer, and has no marketing copy. The wordmark in the bar is the way back to
the site, set the way the nav sets it. Two panes scroll independently and the
page itself does not scroll; below 900px they stack and it does. Its layout
classes are the `hds-playground*` and `hds-compare*` sets in `globals.css`.

**The panes are dark code windows given the whole screen.** The rule that
code is always dark holds everywhere; in the site's dark default the whole
page is black with them. Inside a window: the tab strip is
`--surface-code-alt`, the body `--surface-code`, every rule
`--border-inverse`, never `--border-hairline`. **Cyan is the accent inside a
window** — `--text-accent` (white in dark) is for paper/black surfaces, and
`--cyan-500` is what the system puts on a code surface. The inverse controls
in `components/playground/WindowControls.tsx` are what goes inside a window.
Panes carry `color-scheme: dark` and style their own scrollbars.

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

Dark is the default since the Plety redesign — pure black is the brand
ground, and the landing page paints it unconditionally with Tailwind `bg-black`
regardless of theme. **next-themes is the single source of truth**, configured
on fumadocs' `RootProvider` in `app/layout.tsx` (`defaultTheme: "dark"`) —
fumadocs already runs it for the `/docs` shell, so introducing a second theme
system meant a toggle in the docs sidebar that did nothing. It writes
`class="dark"` on `<html>`, which is exactly the hook the design system's
tokens key on, and injects its own pre-paint script so there is no flash.

The light theme survives as the docs shell's toggle, still wearing the
pre-redesign ivory/Meadow palette (the `:root` override block in
`globals.css`). It is a courtesy, not the brand; check dark first when
shipping a change, and do not build anything new that only works in light.

`lib/theme.tsx` wraps next-themes in a `useTheme()` that returns the
`{ dark, toggle }` shape the design system's `ThemeToggle` expects. Use that
rather than reaching for `next-themes` directly, and note that `<html>` needs
`suppressHydrationWarning` because the class is set before React hydrates.

## Stack

Next.js 15 (static export) · React 19 · Tailwind v4 (the landing page and the
fumadocs shell) · one vendored design system in `website/ds-heddle/`, styled
with CSS custom properties and inline styles, driving the docs, library and
playground · fumadocs for `/docs`, remapped onto the system's tokens in
`globals.css`. Deployed to Cloudflare Pages.

The landing page's animation is hand-rolled: an IntersectionObserver reveal,
CSS transitions and one CSS keyframe. `gsap`, `motion` and `three` were
removed with the loom world; none of them is a dependency of this site any
more.

Layout helpers in `globals.css` are prefixed `hds-` and exist only for what
inline styles cannot express — media queries, `::placeholder`,
`::-webkit-scrollbar`, hover — and only for the `ds-heddle`-built pages; the
landing page uses Tailwind utilities directly.

### The docs shell

`/docs` is fumadocs, which draws its own chrome from Tailwind utilities bound
to `--color-fd-*`. Those are remapped onto the system's aliases at the top of
`globals.css`, and **that block is how the docs inherit the brand** — both
themes come free, because every alias on the right flips with `html.dark`. The
`#nd-*` rules under it are only the shape on top: hairline section rules above
each `h2`, mono uppercase for the sidebar groups and the table of contents,
dark code windows.

Two fumadocs details are load-bearing. Its markup is not a stable interface,
so the selectors that catch the sidebar groups (`#nd-sidebar p`) and the
table-of-contents title (`#nd-toc h3`) were checked against the rendered tree
rather than guessed from utility classes — re-check them after a fumadocs
upgrade. And the TOC lives inside `#nd-page`, so its title rule has to come
*after* the `#nd-page` heading rules it ties with.

Both shiki themes in `source.config.ts` are `github-dark`, on purpose: fumadocs
would otherwise swap in a light theme with the site theme, and code is always
dark here.
