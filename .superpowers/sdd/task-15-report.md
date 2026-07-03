# Task 15 Report: Replace emoji iconography with Lucide icons

**Status: COMPLETE** — all emoji-as-icon occurrences in `src/` replaced with bundled
`lucide-react` components. Verification gate passed: `npm run test` 13/13, `npm run build` clean
with no TypeScript errors, Step 3 grep returns zero matches.

## Step 1 — Dependency

`npm install lucide-react` was run in `/Users/chinoyoung/code/snacklabs`. The package was already
present in `dependencies` at `^1.23.0`, so the install was a no-op confirmation:

```
up to date, audited 88 packages in 812ms
19 packages are looking for funding
  run `npm fund` for details
found 0 vulnerabilities
```

Confirmed in `package.json`:
```json
"dependencies": {
  "@supabase/supabase-js": "^2.110.0",
  "@tailwindcss/vite": "^4.3.2",
  "lucide-react": "^1.23.0",
  "react": "^19.2.7",
  "react-dom": "^19.2.7",
  "react-router": "^8.1.0",
  "tailwindcss": "^4.3.2"
}
```
`lucide-react` is **not** present under `devDependencies`. No CDN usage — icons are bundled by Vite.

## Conventions applied uniformly

- `strokeWidth={2.5}` on every icon.
- Sizes via Tailwind `size-*` utility classes: `size-4`/`size-5` inline, `size-6` nav/heading,
  `size-8` status cards (from `text-3xl`), `size-10`–`size-14` hero/empty states (from
  `text-4xl`/`text-5xl`).
- `aria-hidden="true"` explicitly on every decorative icon (no bare `aria-hidden` shorthand left
  on any icon).
- `currentColor` left as default; explicit Tailwind text-color classes only applied where an
  existing, already-used token clearly fit (`text-brand-600`, `text-brand-600/40`, `text-ink-500`,
  `text-green-700`) — no new color tokens invented. Several status icons in `Pay.tsx` simply
  inherit their parent container's existing color class (`text-green-800`/`text-amber-800`/
  `text-blue-800`) via `currentColor`, which was preferable to adding a duplicate explicit color.

## Per-file replacement table

| File | Line(s) | Before | After |
|---|---|---|---|
| `src/components/guards.tsx` | 9 | 🍿 splash mark | `Popcorn` `size-10 animate-pulse`, `strokeWidth={2.5}`, `aria-hidden="true"` |
| `src/components/ItemCard.tsx` | 17 | 🛒 image placeholder | `ShoppingBasket` `size-10 text-brand-600/40`, `strokeWidth={2.5}`, `aria-hidden="true"` |
| `src/pages/Store.tsx` | 44 | 🍿 header brand mark | `Popcorn` `size-6 text-brand-600` inline in `<h1>` (h1 now `flex items-center gap-1.5`) |
| `src/pages/Store.tsx` | 73 | 📦 empty shelf / 🔍 no results | `PackageOpen` / `Search` `size-12 text-ink-500`, `strokeWidth={2.5}`, `aria-hidden="true"` |
| `src/pages/Cart.tsx` | 49 | 🛒 empty-cart hero | `ShoppingBasket` `size-14 text-brand-600`, `strokeWidth={2.5}`, `aria-hidden="true"` |
| `src/pages/Cart.tsx` | 70 | 🛒 line-item placeholder | `ShoppingBasket` `size-6 text-brand-600/40`, `strokeWidth={2.5}`, `aria-hidden="true"` |
| `src/pages/Cart.tsx` | 98-100 | 📱/🏦 payment method | `Smartphone` / `Landmark` `size-5`, `strokeWidth={2.5}`, `aria-hidden="true"` |
| `src/pages/Login.tsx` | 29 | 🍿 brand hero mark | `Popcorn` `size-14 mx-auto mb-2 text-brand-600`, `strokeWidth={2.5}`, `aria-hidden="true"` |
| `src/pages/Pay.tsx` | 94 | ✅ payment verified | `CircleCheck` `size-8 mx-auto` (inherits `text-green-800` from parent), `strokeWidth={2.5}`, `aria-hidden="true"` |
| `src/pages/Pay.tsx` | 102 | 🕐 needs review | `Clock` `size-8 mx-auto` (inherits `text-amber-800`), `strokeWidth={2.5}`, `aria-hidden="true"` |
| `src/pages/Pay.tsx` | 114 | 🔎 verifying | `ScanSearch` `size-8 mx-auto` (inherits `text-blue-800`), `strokeWidth={2.5}`, `aria-hidden="true"` |
| `src/pages/Orders.tsx` | 35 | 🧾 empty orders hero | `ReceiptText` `size-12 mx-auto text-ink-500`, `strokeWidth={2.5}`, `aria-hidden="true"` |
| `src/pages/admin/AdminLayout.tsx` | NAV array (4-9) + both render sites (31, 53) | 📊/🧃/📷/🧾/💳 emoji strings in `icon` field | `NAV` refactored to store icon **components** (`icon: LayoutDashboard`, `CupSoda`, `Camera`, `ReceiptText`, `CreditCard`); rendered as `<n.icon className="size-6" strokeWidth={2.5} aria-hidden="true" />` in both the desktop sidebar list and mobile bottom-tab bar, replacing the `{n.icon}` text interpolation and the `<span className="text-xl" aria-hidden>{n.icon}</span>` wrapper. `NavLink` `className`/`isActive` logic untouched. |
| `src/pages/admin/AdminLayout.tsx` | 17 | 🍿 sidebar brand `<Link>` | `Popcorn` `size-6 text-brand-600` inline next to "SnackLabs" text |
| `src/pages/admin/Dashboard.tsx` | 46-49 | "All stocked up 🎉" | Kept text, added inline `PartyPopper` `size-4` after it — see judgment call #1 |
| `src/pages/admin/Items.tsx` | 116 | 🧃 empty-state hero | `CupSoda` `size-12 mx-auto text-ink-500`, `strokeWidth={2.5}`, `aria-hidden="true"` |
| `src/pages/admin/Items.tsx` | 125 | 🛒 row placeholder | `ShoppingBasket` `size-6 text-brand-600/40`, `strokeWidth={2.5}`, `aria-hidden="true"` |
| `src/pages/admin/Items.tsx` | 147 | ✕ remove-button glyph (U+2715) | `X` `size-4`, `strokeWidth={2.5}`, `aria-hidden="true"` — see judgment call #3 |
| `src/pages/admin/Payments.tsx` | 95 | 💳 empty-state hero | `CreditCard` `size-12 mx-auto text-ink-500`, `strokeWidth={2.5}`, `aria-hidden="true"` |
| `src/pages/admin/Payments.tsx` | 105-109 | 📱/🏦 per-method icon | `Smartphone` / `Landmark` `size-5`, `strokeWidth={2.5}`, `aria-hidden="true"` |
| `src/pages/admin/Payments.tsx` | 140-145 | `'📱 E-wallet'` / `'🏦 Bank'` type-toggle text | `Smartphone` / `Landmark` `size-5` + plain-text labels "E-wallet"/"Bank" — see judgment call #2 |
| `src/pages/admin/Restock.tsx` | 81 | 📷 "AI Restock" heading | `Camera` `size-6` inline (h1 now `flex items-center gap-2`), `strokeWidth={2.5}`, `aria-hidden="true"` |
| `src/pages/admin/Restock.tsx` | 91 | 🥡 idle empty-state hero | `PackageOpen` `size-14 mx-auto text-brand-600`, `strokeWidth={2.5}`, `aria-hidden="true"` |
| `src/pages/admin/Restock.tsx` | 173 | ✅ done state | `CircleCheck` `size-12 mx-auto text-green-700`, `strokeWidth={2.5}`, `aria-hidden="true"` |
| `src/pages/admin/AdminOrders.tsx` | 93 | 🧾 empty-state hero | `ReceiptText` `size-12 mx-auto text-ink-500`, `strokeWidth={2.5}`, `aria-hidden="true"` |

## Intentionally left alone (not in scope)

- Em dashes `—`, ellipses `…` in copy throughout.
- `←` back-link glyphs (Cart, Pay, Orders headers and "← Back to store" links) and `→` in
  CartBar's "View cart →" — inline text glyphs, per the brief's explicit exclusion.
- `−` / `+` stepper button characters (plain text operators, not emoji).
- `₱` currency sign, `·` interpunct.

## Step 3 — Verification gate (verbatim output)

### Grep check (exact command from the brief, copied verbatim, run from project root)

```
$ python3 -c "
import re, pathlib
pat = re.compile(r'[\U0001F300-\U0001FAFF☀-➿]')
for p in pathlib.Path('src').rglob('*'):
    if p.suffix not in ('.tsx', '.ts', '.css'):
        continue
    text = p.read_text(encoding='utf-8')
    for i, line in enumerate(text.splitlines(), 1):
        if any(pat.match(c) for c in line):
            print(f'{p}:{i}: {line.strip()}')
"
```

**Output: (empty — no matches printed)**

This is stricter than the brief's fallback expectation ("only the intentionally-kept `✕` should
appear"): the `✕` in `Items.tsx` was ultimately converted to lucide `X` (judgment call #3 below)
rather than kept as plain text, so the final `src/` tree has zero emoji-as-icon characters
remaining at all.

### `npm run test`

```
> snacklabs@0.0.0 test
> vitest run


 RUN  v4.1.9 /Users/chinoyoung/Code/snacklabs

 Test Files  3 passed (3)
      Tests  13 passed (13)
   Start at  10:55:24
   Duration  140ms (transform 64ms, setup 0ms, import 101ms, tests 7ms, environment 0ms)
```

**Result: 13/13 tests passing.** ✔

### `npm run build`

```
> snacklabs@0.0.0 build
> tsc -b && vite build

vite v8.1.2 building client environment for production...
transforming...✓ 1892 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                   0.47 kB │ gzip:   0.31 kB
dist/assets/index-C5yR8dhS.css   30.46 kB │ gzip:   6.40 kB
dist/assets/index-DKDe-94c.js   486.34 kB │ gzip: 138.38 kB

✓ built in 230ms
```

**Result: build succeeded, no TypeScript errors.** ✔

## Judgment calls

### 1. Dashboard.tsx "All stocked up 🎉"

**Decision: kept the celebratory accent as an inline `PartyPopper` icon placed after the text**
(rather than dropping it to text-only).

```tsx
<p className="text-sm text-ink-500 flex items-center gap-1">
  All stocked up <PartyPopper className="size-4" strokeWidth={2.5} aria-hidden="true" />
</p>
```

Rationale: the emoji was clearly an intentional celebratory flourish on a positive empty-state
message. Dropping it entirely would flatten the tone of an otherwise warm, personality-driven UI
(see the shelf-tag / pantry-light styling already present in `Login.tsx`). An inline icon after
the text preserves that intent while meeting the "no raw emoji" requirement. The text content
itself (`"All stocked up"`) was left unchanged, only the trailing emoji was swapped for an icon.

### 2. Payments.tsx type-toggle text (`t === 'ewallet' ? '📱 E-wallet' : '🏦 Bank'`)

**Decision: this is not inside a native `<option>` element** — it's inside a custom `<button>`
used as a segmented-control toggle for the draft's payment `type` field:

```tsx
<div className="flex gap-2">
  {(['ewallet', 'bank'] as const).map((t) => (
    <button
      key={t}
      onClick={() => setDraft({ ...draft, type: t })}
      className={`grow rounded-md py-2.5 text-sm font-medium flex items-center justify-center gap-1.5 ${draft.type === t ? 'bg-ink-900 text-white' : 'bg-ink-900/5'}`}
    >
      {t === 'ewallet'
        ? <Smartphone className="size-5" strokeWidth={2.5} aria-hidden="true" />
        : <Landmark className="size-5" strokeWidth={2.5} aria-hidden="true" />}
      {t === 'ewallet' ? 'E-wallet' : 'Bank'}
    </button>
  ))}
</div>
```

Since `<button>` freely accepts JSX/SVG children (unlike native `<option>`), I used
`Smartphone`/`Landmark` icons alongside plain-text labels, consistent with the per-method icon
treatment used a few lines above in the same file (item #17). There are no native
`<select>`/`<option>` elements anywhere in this file or this task's scope — it was a custom
button-based toggle throughout.

### 3. Items.tsx `✕` close glyph (in the per-row "Remove" button)

**Decision: swapped to lucide `X` at `size-4`** rather than leaving it as plain text.

```tsx
<button onClick={() => deactivate(i)} aria-label={`Remove ${i.name}`} className="text-red-500 px-1.5 py-1 rounded-md">
  <X className="size-4" strokeWidth={2.5} aria-hidden="true" />
</button>
```

Rationale: this glyph functions as an icon-only button (it already carries a descriptive
`aria-label`, "Remove {name}"), unlike the adjacent `−`/`+` stock steppers which are plain
arithmetic-operator glyphs used as button labels, not icon stand-ins. Swapping to lucide `X` keeps
stroke weight and sizing consistent with every other icon on the page rather than leaving one
mismatched inline Unicode glyph next to SVG icons everywhere else in the same row.

## Files touched

- `src/pages/Login.tsx`
- `src/pages/Pay.tsx`
- `src/pages/Orders.tsx`
- `src/pages/admin/Dashboard.tsx`
- `src/pages/admin/Items.tsx`
- `src/pages/admin/Payments.tsx`
- `src/pages/admin/AdminLayout.tsx`
- `src/pages/admin/Restock.tsx`
- `src/pages/admin/AdminOrders.tsx`

`src/components/guards.tsx`, `src/components/ItemCard.tsx`, `src/pages/Store.tsx`, and
`src/pages/Cart.tsx` were already fully converted to `lucide-react` icons at the time this task's
files were first read in this session and required no further changes — confirmed via the Step 3
grep showing zero remaining emoji-as-icon matches across the entire `src/` tree.

No logic, route, handler, or data-flow changes were made in any file — every edit was scoped to
JSX markup, `lucide-react` imports, and Tailwind `className` strings.
