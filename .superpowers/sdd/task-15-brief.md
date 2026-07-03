### Task 15: Replace emoji iconography with Lucide icons

**Files:**
- Modify: `package.json`, `package-lock.json` (via npm install)
- Modify: `src/components/guards.tsx`, `src/components/ItemCard.tsx`, `src/pages/Store.tsx`,
  `src/pages/Cart.tsx`, `src/pages/Login.tsx`, `src/pages/Pay.tsx`, `src/pages/Orders.tsx`,
  `src/pages/admin/AdminLayout.tsx`, `src/pages/admin/Dashboard.tsx`, `src/pages/admin/Items.tsx`,
  `src/pages/admin/Payments.tsx`, `src/pages/admin/Restock.tsx`, `src/pages/admin/AdminOrders.tsx`

**Interfaces:**
- Consumes: `lucide-react` npm package (new dependency, bundled — no CDN).
- Produces: no behavior/route/data changes — pure styling/markup swap of emoji-as-icon glyphs for
  `lucide-react` SVG components.

**Do NOT touch:** punctuation/typography characters used in copy — em dash `—`, ellipsis `…`,
arrows used as inline text glyphs in `Cart.tsx`/`Orders.tsx` back-links (`←`, `→`), and the `✕`
close glyph in `Items.tsx` (only replace if it reads clearly as an icon — see Step 2 note). These
are NOT part of this task's "emoji as icon" scope unless explicitly listed below.

- [ ] **Step 1: Install dependency**

Run `npm install lucide-react` in `/Users/chinoyoung/code/snacklabs`. Verify it lands in
`dependencies` in `package.json` (not devDependencies).

- [ ] **Step 2: Sweep and replace emoji icons**

Confirmed emoji-as-icon occurrences (from a full `src/` grep) and required mapping:

1. `src/components/guards.tsx:8` — 🍿 loading spinner mark → `Popcorn`, large size (`size-12` or
   `size-10`), keep `animate-pulse` on it, `aria-hidden="true"`, `strokeWidth={2.5}`.
2. `src/components/ItemCard.tsx:16` — 🛒 placeholder when no image → `ShoppingBasket`, `size-8`ish
   (currently `text-4xl`), `aria-hidden="true"`, `strokeWidth={2.5}`, `text-ink-300`/muted color if
   there's a sensible existing muted class nearby, else default currentColor.
3. `src/pages/Cart.tsx:48` — 🛒 empty-cart hero → `ShoppingBasket`, hero size (`size-12`–`size-16`),
   brand color if that reads well, `aria-hidden="true"`.
4. `src/pages/Cart.tsx:69` — 🛒 same placeholder pattern as ItemCard, same treatment as #2.
5. `src/pages/Cart.tsx:97` — payment method icon: `m.type === 'ewallet' ? 📱 : 🏦` →
   `Smartphone` / `Landmark`, `size-5` inline, `aria-hidden="true"`.
6. `src/pages/Store.tsx:42` — 🍿 brand mark in store header → `Popcorn`, `size-6`ish inline next to
   "SnackLabs" text, `aria-hidden="true"` (text "SnackLabs" already conveys the name to
   screen readers).
7. `src/pages/Store.tsx:69` — empty/no-results state: `items.length === 0 ? 📦 : 🔍` →
   `PackageOpen` / `Search`, hero size (`size-12`+), `aria-hidden="true"`.
8. `src/pages/Login.tsx:28` — 🍿 brand hero mark → `Popcorn`, large hero size (`size-12`–`size-16`),
   brand color where it fits, `aria-hidden="true"`.
9. `src/pages/Pay.tsx:93` — ✅ payment verified → `CircleCheck`, `size-8`ish (was `text-3xl`),
   `aria-hidden="true"`, use a success/green color if a token exists, else currentColor.
10. `src/pages/Pay.tsx:101` — 🕐 pending/awaiting state → `Clock`, same sizing pattern as #9.
11. `src/pages/Pay.tsx:113` — 🔎 verifying-with-AI state → `ScanSearch`, same sizing pattern as #9.
12. `src/pages/Orders.tsx:34` — 🧾 empty orders hero → `ReceiptText`, hero size, `aria-hidden="true"`.
13. `src/pages/admin/Dashboard.tsx:46` — "All stocked up 🎉" → replace trailing emoji with inline
    `PartyPopper` icon (`size-4`/`size-5`, `aria-hidden="true"`) placed after the text, or drop it
    and keep text-only — pick whichever reads cleaner; note your choice in the report. Do not
    change the text content itself otherwise.
14. `src/pages/admin/Items.tsx:115` — 🧃 empty-state hero → `CupSoda`, hero size, `aria-hidden="true"`.
15. `src/pages/admin/Items.tsx:124` — 🛒 placeholder, same pattern as #2.
16. `src/pages/admin/Payments.tsx:95` — 💳 empty-state hero → `CreditCard`, hero size,
    `aria-hidden="true"`.
17. `src/pages/admin/Payments.tsx:105` — 📱/🏦 per-method icon → `Smartphone`/`Landmark`, `size-5`
    inline, `aria-hidden="true"` (label text `{m.label}` still conveys meaning).
18. `src/pages/admin/Payments.tsx:140` — `t === 'ewallet' ? '📱 E-wallet' : '🏦 Bank'` select-option
    label text. This is inside a `<select>` `<option>` (verify) — native `<option>` elements cannot
    render SVG children. If it is indeed plain option text, strip the emoji and keep
    `'E-wallet'` / `'Bank'` as plain text (icons don't render inside native `<option>`); if it's
    actually rendered as a custom (non-native) control that accepts JSX, use `Smartphone`/`Landmark`
    consistent with #17. Check the surrounding JSX before deciding and note which case applied in
    the report.
19. `src/pages/admin/AdminLayout.tsx` — NAV array: replace emoji strings with icon COMPONENTS:
    - `📊` → `LayoutDashboard`
    - `🧃` → `CupSoda`
    - `📷` → `Camera`
    - `🧾` → `ReceiptText`
    - `💳` → `CreditCard`
    Refactor `NAV` to `{ to, label, icon: <Component>, end }` (store the component reference itself,
    e.g. `icon: LayoutDashboard`), then render `<n.icon className="size-6" strokeWidth={2.5} aria-hidden="true" />`
    in both the desktop sidebar list and the mobile bottom-tab bar (replacing `{n.icon}` text
    interpolation and the `<span className="text-xl" aria-hidden>{n.icon}</span>` wrapper). Preserve
    all existing NavLink `className`/`isActive` logic exactly — this is a rendering swap only.
    Also replace the 🍿 in the sidebar brand `<Link>` (line 15) with `Popcorn`, `size-6` inline,
    `aria-hidden="true"`, next to the "SnackLabs" text.
20. `src/pages/admin/Restock.tsx:79` — 📷 in "AI Restock" heading → `Camera`, `size-6` inline,
    `aria-hidden="true"`.
21. `src/pages/admin/Restock.tsx:87` — 🥡 empty-state hero → `PackageOpen`, hero size,
    `aria-hidden="true"`.
22. `src/pages/admin/Restock.tsx:169` — ✅ done state → `CircleCheck`, hero size (was `text-4xl`),
    `aria-hidden="true"`.
23. `src/pages/admin/AdminOrders.tsx:92` — 🧾 empty-state hero → `ReceiptText`, hero size,
    `aria-hidden="true"`.

For every replacement: import icons from `lucide-react` at the top of each file, apply
`strokeWidth={2.5}` uniformly, size via Tailwind `size-*` utility classes (map existing `text-3xl`
→ roughly `size-8`, `text-4xl` → `size-10`/`size-12`, `text-5xl` → `size-12`/`size-14`, `text-xl`
inline nav → `size-6`, unmarked inline like the payment-method spans → `size-5`), keep
`aria-hidden="true"` on every decorative icon (convert any bare `aria-hidden` shorthand to
`aria-hidden="true"` explicitly for consistency), and leave `currentColor` as default (no `fill`,
no explicit `color` prop) unless the report calls out a specific brand/success color token that
already exists in this codebase's Tailwind config — do not invent new color tokens.

Do NOT touch the em dash (—), ellipsis (…), arrow glyphs (← →) used as inline text/back-link
glyphs in Cart.tsx/Orders.tsx/Pay.tsx, or the `✕` remove-button glyph in `Items.tsx:146` (that one
is borderline — leave it as plain text `✕` since it's a tiny inline dismiss glyph, not required by
the task's enumerated mapping; note it in the report as "kept" if you leave it, or swap to lucide
`X` at `size-4` if you judge it clearly reads as an icon — controller's call, document your choice).

- [ ] **Step 3: Verification gate**

Run `npm run test` (must be 13/13 passing) and `npm run build` (must succeed with no TS errors).
Then run this grep from the project root to confirm no icon-emoji remain in `src/`:

```
python3 -c "
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

Only the intentionally-kept `✕` (if kept as text) should appear, plus nothing else in that
emoji range. (Em dash/ellipsis/arrows fall outside this regex range so they won't show up.) Paste
the grep output verbatim into the report.

- [ ] **Step 4: Report**

Write a full report to `/Users/chinoyoung/code/snacklabs/.superpowers/sdd/task-15-report.md`
covering: per-file emoji→icon replacement table, the Step 3 grep output, full `npm run test` and
`npm run build` output (or tails showing pass/fail + counts), and any judgment calls made (the
Dashboard 🎉 decision, the Payments `<option>` text decision, the Items.tsx `✕` decision).
