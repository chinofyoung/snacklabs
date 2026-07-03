# Task 29 — Admin frontend restructure (Settings, cash payments, nav)

## Files changed

### src/types.ts
- `PaymentMethod.type` widened to `'ewallet' | 'bank' | 'cash'`.
- `PaymentMethod.qr_image_url` changed to `string | null` (nullable for cash).
- Added `AppSettings` interface: `{ payment_ai_enabled: boolean; payment_ai_model: 'claude-haiku-4-5' | 'claude-sonnet-5' | 'claude-opus-4-8' }`.

### src/pages/admin/Payments.tsx
Refactored from a standalone page into a reusable `PaymentMethods` component (default export renamed, same file). All existing logic preserved: load/save/toggle, image compression + upload to `qr-codes` bucket, error handling via `setError`/destructured `error`.
- Outer wrapper changed from a full-page `<div className="p-4 md:p-8 ...">` with `<h1>` to a section-local `<div className="space-y-4">` with `<h2>`, since it now renders inside the Settings page's card.
- Three-way type toggle: E-wallet / Bank / **Cash** (added `Banknote` icon for cash, kept `Smartphone`/`Landmark` for the others).
- Cash handling: file input and "QR code image" label are hidden when `type === 'cash'`, replaced with "No QR needed for cash." `qr_image_url` is forced to `null` on save for cash. Validation only requires the QR file for `ewallet`/`bank` new methods; label + account_name always required.
- Account name field is relabeled "Label / where to pay" when `type === 'cash'`; the account/mobile number field is hidden entirely for cash.
- List rendering: methods without `qr_image_url` (cash) show a `Banknote` icon tile in place of the QR thumbnail. Disable/enable + edit actions unchanged.

### src/pages/admin/Settings.tsx (new)
Two card sections (`rounded-2xl bg-surface-raised shadow-sm p-4/5`, matching Dashboard/Items styling):
1. **AI payment verification** — fetches `app_settings` singleton row (`select('*').single()`) on mount; destructures and surfaces `error`. A switch-styled toggle bound to `payment_ai_enabled` with the exact OFF helper copy from the spec. A 3-button segmented model selector (Haiku/Sonnet/Opus mapped to the exact enum values) with the specified cost hints, disabled/greyed (`opacity-40 pointer-events-none` + `disabled`) when the toggle is off. Save button writes both fields plus `updated_at: new Date().toISOString()` via `.eq('id', true)`, shows a transient "Saved" message (2s timeout) and surfaces save errors.
2. **Payment methods** — renders `<PaymentMethods />` (imported from `./Payments`) inside its own card.

### src/pages/Pay.tsx
- Imported `Banknote` from lucide-react.
- Branched the payment-details block on `method.type`: for `'cash'`, renders a large `Banknote` icon plus copy "Pay {formatPeso(order.total)} in cash — hand it to {method.account_name} or drop it in the box, then upload a photo of the cash you're paying." (method label kept above it). For `ewallet`/`bank`, kept the original QR `<img>` block unchanged (added `?? undefined` guard since `qr_image_url` is now nullable in types).
- `PaymentStatus` (upload → `verify-payment` invoke) untouched — same flow drives both cash and QR methods.

### src/pages/admin/Items.tsx
- Added `useNavigate` (react-router) and `Camera` (lucide-react) imports.
- Header now wraps "+ Add item" and a new icon-only Camera button (`aria-label="AI restock"`, same brand-600 styling) in a flex row; the Camera button calls `navigate('/admin/restock')`.

### src/pages/admin/AdminLayout.tsx
- `NAV` reduced to exactly: Dashboard (`/admin`, `LayoutDashboard`, end:true), Items (`/admin/items`, `CupSoda`), Orders (`/admin/orders`, `ReceiptText`), Settings (`/admin/settings`, `Settings`). Removed Restock and Payments nav entries.
- Import list updated: added `Settings`, dropped now-unused `Camera` and `CreditCard`.
- "Back to store" link and mobile bottom nav (which maps over the same `NAV` array) unchanged structurally.

### src/App.tsx
- Imported `Navigate` from `react-router`; swapped `Payments` page import for `Settings`.
- Added `<Route path="settings" element={<Settings />} />`.
- Replaced `<Route path="payments" element={<Payments />} />` with `<Route path="payments" element={<Navigate to="/admin/settings" replace />} />` so old bookmarks/links redirect instead of 404ing.
- `restock` route retained (still reachable via the Items camera button, just removed from nav).

## Verification
- `npm run test` → 4 test files, **25/25 passed** (spec said 24/24; baseline before my changes was already 25/25 — no admin-page tests exist, so the count is unaffected by this work).
- `npm run build` → `tsc -b && vite build` clean, no errors.
- `npx oxlint src` → clean, no warnings.
- Grepped for dangling `Payments` references and old `/admin/payments` literals — only remaining reference is the new `Settings.tsx` import of `PaymentMethods` from `./Payments`, which resolves correctly (default export renamed but path unchanged).
- Confirmed `lucide-react` exports `Banknote`, `Settings`, `Camera`, `Coins` (used `Banknote`).
- Read `supabase/migrations/20260703044303_app_settings.sql` to confirm the `app_settings` table/columns/constraints/RLS match the UI contract exactly (singleton `id=true`, `payment_ai_enabled boolean not null default true`, `payment_ai_model` check constraint with the three model values, admin-only read/write policies).

## Concerns
- None blocking. Did not touch `supabase/functions` or migrations per instructions — confirmed the DB contract already matches what the UI now expects (checked via read-only grep of the migrations directory).
- The Settings toggle is a custom `role="switch"` button, not a native `<input type="checkbox">`, to match the "styled switch" option in the spec — keyboard/screen-reader behavior relies on the `role`/`aria-checked`/`aria-label` attributes rather than native semantics.
