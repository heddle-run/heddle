# Vendored FormFlow design system — deviations from upstream

Source: the **FormFlow Design System** Claude Design project
(`a33c66cb-3e63-41f1-b340-1f58512f3144`).

`ds/` is a faithful copy so upstream updates stay mergeable. heddle's own site
components live in `components/` and are built *from* this directory — no
heddle-specific code belongs in here. Three deliberate deviations:

## 1. Icons render through `lucide-react`, not the Iconify CDN

Upstream `Icon.jsx` emits `<span class="iconify" data-icon="lucide:…">` and
relies on `code.iconify.design` being loaded at runtime.

This site is a **static export**. A runtime CDN dependency means every icon is
a blocking third-party fetch that paints after hydration, and the icons vanish
entirely offline or if the CDN is blocked. `lucide-react` was already a
dependency of this project.

The set is unchanged — same Lucide glyphs, same 24px grid, ~1.5px stroke, round
caps, no fills. Only the delivery changed. `Icon.jsx` keeps the upstream API
(kebab-case `name`, `size`, `color`) and resolves through an explicit registry
so unused glyphs stay out of the bundle and a typo fails loudly instead of
rendering an empty box.

Adding a glyph: import it in `ds/components/core/Icon.jsx` and add it to
`REGISTRY`.

## 2. Inter is loaded via `next/font/google`

Upstream `tokens/fonts.css` pulls Inter with an `@import` from Google Fonts.
Same reasoning as above: `next/font` self-hosts the file, preloads it and
eliminates the fallback flash. The `@import` is commented out in place;
`app/layout.tsx` assigns Inter to `--font-inter` and `app/globals.css` maps it
onto `--font-sans`. Same family, same four weights.

## 3. `"use client"` added to components that use React hooks

The App Router needs an explicit client boundary for any component calling
`useState`/`useEffect`. Fifteen components got the directive; the rest are
untouched and still render on the server. No logic changed.

Pure (server-renderable): `Icon`, `Badge`, `BoxedFrame`, `WindowChrome`,
`Backdrop`, `Marquee`, `Field`, `FormCard`, `SiteFooter`, `Wordmark`.

---

Everything else — all eight token files, and the component source itself — is
byte-for-byte upstream.

## Not vendored

`Wordmark.jsx` ships upstream rendering the literal string `FORMFLOW`. It is
copied verbatim but **unused**; heddle's wordmark is
`components/Wordmark.tsx`, built in the same idiom (Lucide glyph + Inter Medium
lockup) with heddle's own name. Upstream's readme explicitly invites this
substitution.
