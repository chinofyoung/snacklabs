# Task 14 — Step 1: Visual polish pass

## Design direction

Subject: an office pantry / honor-system snack shelf. Signature element: the login
screen renders the SnackLabs wordmark as a hanging price/shelf tag (punched hole,
warm card, ambient orange glow on a near-black background) instead of a generic
centered logo-and-button screen. Everywhere else, the existing warm-neutral +
orange-accent direction was kept but tightened into a real token system: one radius
scale, one shadow token, warm (not cold) grays, tabular numerals for money, and
`focus-visible` outlines on every interactive element. The orange accent is now
reserved for primary actions (place order, add to cart, upload receipt, restock CTA)
— secondary actions use ink/neutral surfaces.

## Files changed (14 source files + 2 housekeeping)

- `src/index.css` — Added a full design-token layer: warm surface/ink/line colors,
  brand scale, a `--font-display` rounded system stack + `--font-sans` body stack,
  a 4-step radius scale, one card shadow + one "float" shadow token, global
  `focus-visible` rule for all interactive elements, `tabular-nums` utility,
  `prefers-reduced-motion` support.
- `src/pages/Login.tsx` — New distinctive screen: dark ambient background, glowing
  radial gradient, "shelf tag" card with punch-hole detail as the signature visual,
  real Google "G" icon button instead of a plain dark button.
- `src/pages/Store.tsx` — Header uses hairline divider + design tokens; search input
  and chips use `focus-visible` and shadow tokens; split empty state into "shelf is
  empty" (no items at all) vs "nothing matches filter" (has items, filtered to zero).
- `src/components/ItemCard.tsx` — Consistent radius/shadow tokens, "Out of stock"
  badge overlay + grayscale instead of just opacity, low-stock text turns amber,
  tabular-nums price, clearer disabled-button style.
- `src/components/CartBar.tsx` — Uses shared radius/shadow tokens, tabular-nums total.
- `src/pages/Cart.tsx` — Better empty-cart state (icon + two-line copy), a11y labels
  on stepper buttons, `role="alert"` on error text, token-based radii/shadows.
- `src/pages/Pay.tsx` — Token-based radii/shadows, `role="alert"` on error, decorative
  emoji marked `aria-hidden`.
- `src/pages/Orders.tsx` — Redesigned empty state (icon, copy, back-to-store link),
  status badges use ink-neutral instead of stone gray, tabular-nums totals.
- `src/components/guards.tsx` — Splash/loading screen gets a small pulsing pantry
  icon instead of bare "Loading…" text.
- `src/pages/admin/AdminLayout.tsx` — Sidebar/bottom-tab nav restyled with token
  colors, bottom tab targets given explicit min-width/padding for tap-target size.
- `src/pages/admin/Dashboard.tsx` — Token-based cards/radii, tabular-nums for money
  and counts, "Needs review" card no-hover-shadow-jump affordance.
- `src/pages/admin/Items.tsx` — Added an empty-catalog state, a11y labels on stock
  +/- buttons and remove button, `role="alert"` on errors, token-based modal sheet.
- `src/pages/admin/Payments.tsx` — Added an empty-state for no payment methods,
  token-based radii/shadows/modal, `role="alert"` on errors.
- `src/pages/admin/AdminOrders.tsx` — Redesigned empty state per filter, token-based
  card/shadow/radius, `role="alert"` on receipt-load error.
- `src/pages/admin/Restock.tsx` — Token-based radii/shadows throughout all four
  phases (idle/analyzing/review/done), a11y labels on checkboxes/inputs.
- `index.html` — `<title>` changed from "scaffold" to "SnackLabs — Office Pantry".
- `package.json` — `name` changed from "scaffold" to "snacklabs".

No changes were made under `supabase/`. No behavior, route, or data-flow logic was
touched — all edits are className/markup/copy-for-empty-states only. Verified in the
live dev server via preview tooling at 375px: login renders correctly, unauthenticated
routes still redirect to `/login` as before (routing behavior unchanged), no console
errors, and the compiled CSS confirms the `focus-visible` rules and design tokens are
present and correctly scoped.

## Gate results

- `npm run test` → **13/13 passed** (3 test files: cart.test.ts, money.test.ts, and
  the shared functions test file covered by the vitest include glob).
- `npm run build` → **succeeded**, `tsc -b` reported no type errors, `vite build`
  completed (dist/index.html, dist/assets/index-*.css 29.66 kB, dist/assets/index-*.js
  479.11 kB).
