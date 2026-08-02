# Vendored Heddle design system — deviations from upstream

Source: the **Heddle Design System** Claude Design project
(`2028ba65-c304-4d64-a4c6-09cbf88891be`).

`ds-heddle/` is a faithful copy so upstream updates stay mergeable. heddle's own
site components live in `components/` and are built *from* this directory — no
site-specific code belongs in here. Every page on the site runs on this system.

A fourth deviation used to head this list: while the FormFlow system in `ds/`
still drove the playground and the docs, every token block and element style
here was scoped under a `.hds` class, because forty-two property names collide
between the two systems and whichever stylesheet landed last would have
restyled the other's pages. `ds/` is gone, and with it that deviation — tokens
are back on `:root` and element styles on `body`, as upstream ships them. The
scoping is worth knowing about only if you are reading old commits.

## 1. The dark theme keys on `html.dark`, not `data-theme="dark"`

Upstream flips its aliases with `:root[data-theme="dark"]` and persists the
choice itself in `localStorage`. This site already has a theme system —
next-themes on fumadocs' `RootProvider`, which writes `class="dark"` on
`<html>` and injects its own pre-paint script. Running both would mean two
sources of truth and a flash.

The dark block's selector is rewritten to `html.dark`. Alias values are
upstream's, verbatim.

## 2. Fonts load through `next/font/google`

Upstream `tokens/fonts.css` pulls IBM Plex Sans, IBM Plex Mono and Instrument
Serif with an `@import` from Google Fonts. `next/font` self-hosts, preloads and
eliminates the fallback flash. The `@import` is commented out in place;
`app/layout.tsx` assigns the three families to `--font-plex-sans`, `--font-plex-mono` and
`--font-instrument`, and `tokens/fonts.css` maps them onto the system's own
`--font-*` aliases. Same families, same weights.

## 3. `"use client"` added to components that use React hooks

The App Router needs an explicit client boundary for any component calling
`useState`. Four components got the directive: `Tabs`, `Tooltip`, `CodeBlock`,
`InstallCommand`. The rest are directive-free and render on the server.

## Not vendored

Per-component `.d.ts` and `.prompt.md` files, `guidelines/`, `SKILL.md`,
`_ds_bundle.js` and the `templates/`/`ui_kits/` trees are Claude Design
authoring artifacts, not library code. The typed surface the site codes
against is the hand-rolled `index.d.ts`. The landing ui-kit and page template
were used as the reference for `components/*.tsx` and are kept in
`website/.ds-import/`
(git-ignored).
