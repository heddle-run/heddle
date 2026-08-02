# Vendored Heddle design system — deviations from upstream

Source: the **Heddle Design System** Claude Design project
(`2028ba65-c304-4d64-a4c6-09cbf88891be`).

`ds-heddle/` is a faithful copy so upstream updates stay mergeable. heddle's own
site components live in `components/` and are built *from* this directory — no
site-specific code belongs in here. The landing page runs on this system; the
playground, compare and docs still run on the FormFlow system in `ds/` until
they are migrated, which is the whole reason the deviations below exist.

## 1. Tokens are scoped to `.hds`, not `:root`

Upstream declares every custom property on `:root` and its element styles on
`body`. Forty-two property names (`--surface-card`, `--text-strong`,
`--border-default`, `--radius-*`, `--space-*`, …) collide with the FormFlow
tokens in `ds/`, which still drive the playground, compare and docs. Loading
both at `:root` would let whichever stylesheet lands last restyle the other
system's pages.

So every token block and element style here is scoped under a `.hds` class;
the landing page wraps itself in `<div className="hds">`. Custom properties
inherit, so components resolve identically inside the wrapper. When the rest of
the site migrates and `ds/` is removed, this scoping can be reverted to
upstream's `:root`/`body` selectors.

## 2. The dark theme keys on `html.dark`, not `data-theme="dark"`

Upstream flips its aliases with `:root[data-theme="dark"]` and persists the
choice itself in `localStorage`. This site already has a theme system —
next-themes on fumadocs' `RootProvider`, which writes `class="dark"` on
`<html>` and injects its own pre-paint script. Running both would mean two
sources of truth and a flash.

The dark block's selector is rewritten to `:where(html.dark) .hds` (zero
specificity on the html part, so it composes with rule 1). Alias values are
upstream's, verbatim.

## 3. Fonts load through `next/font/google`

Upstream `tokens/fonts.css` pulls IBM Plex Sans, IBM Plex Mono and Instrument
Serif with an `@import` from Google Fonts. `next/font` self-hosts, preloads and
eliminates the fallback flash — the same reasoning as the Inter deviation in
`ds/DEVIATIONS.md`. The `@import` is commented out in place; `app/layout.tsx`
assigns the three families to `--font-plex-sans`, `--font-plex-mono` and
`--font-instrument`, and `tokens/fonts.css` maps them onto the system's own
`--font-*` aliases. Same families, same weights.

## 4. `"use client"` added to components that use React hooks

The App Router needs an explicit client boundary for any component calling
`useState`. Four components got the directive: `Tabs`, `Tooltip`, `CodeBlock`,
`InstallCommand`. The rest are directive-free and render on the server.

## Not vendored

Per-component `.d.ts` and `.prompt.md` files, `guidelines/`, `SKILL.md`,
`_ds_bundle.js` and the `templates/`/`ui_kits/` trees are Claude Design
authoring artifacts, not library code. The typed surface the site codes
against is the hand-rolled `index.d.ts`, mirroring how `ds/` is typed. The
landing ui-kit and page template were used as the reference for
`components/*.tsx` and are kept for reference in `website/.ds-import/`
(git-ignored).
