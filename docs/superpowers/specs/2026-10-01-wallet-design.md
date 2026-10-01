# SnackLabs — Wallet & Customer Bottom Nav: Design Spec

**Date:** 2026-10-01
**Status:** Approved by user (brainstorming session)

## Overview

Two related additions to the existing SnackLabs pantry store:

1. **A wallet.** Customers top up by paying through an existing payment
   method and uploading proof; an admin manually approves or rejects the
   request; an approved request credits the customer's balance. The balance
   is then spendable at checkout as an additional payment method.
2. **A customer bottom nav.** The customer side gains a persistent tab bar —
   Store, My orders, Top up, Settings — mirroring the one `AdminLayout`
   already uses on mobile.

The wallet is **purely additive**. The existing per-order flow (QR / cash +
receipt upload + AI verification) is unchanged and remains available. Paying
from the wallet skips proof and AI entirely — the money was already verified
at top-up time.

## Decisions made during brainstorming

| Question | Decision |
|---|---|
| Wallet's role at checkout | An **additional payment method** alongside GCash/bank/cash. Proof + approval happen only at top-up. |
| Void/cancel of a wallet-paid order | **Auto-refund** to the wallet, with a reversal entry in the ledger. |
| Admin actions on a top-up request | **Approve or reject only.** No amount editing, no manual balance adjustments. Credited amount always equals requested amount. |
| Customer Settings tab contents | Profile card (read-only), Admin console link for admins, Privacy, Terms, Sign out. |
| Balance storage | **Cached balance + append-only ledger** (`wallets` + `wallet_entries`), both moved in one locked transaction, with `check (balance >= 0)`. |
| Pending top-ups per customer | **One at a time.** |
| DB invariant testing | **pgTAP suite wired into an npm script.** |
| Admin Users page | Gains a **read-only** balance column. |

## Architecture

### Why the money logic lives in triggers

`supabase/migrations/20260908130000_stock_holds_on_review.sql` moved stock
accounting out of the RPCs and into triggers on `public.orders`, with an
explicit rationale: two of the three places that change an order's status are
plain table updates, not RPCs, and so cannot be taught to "remember" to move
stock —

- `supabase/functions/verify-payment/index.ts` sets `status = 'needs_review'`
  with a plain service-role `.update(...)`.
- `src/pages/admin/AdminOrders.tsx`'s `reject()` sets `status = 'cancelled'`
  with a plain `.update(...)`.

Wallet money has exactly the same shape of problem, so it gets exactly the
same answer: **debits and refunds happen in triggers on `public.orders`,
mirroring `sync_order_stock` / `release_order_stock`.**

The payoff is that the auto-refund decision above comes out for free on every
path — `void_order`, `delete_all_orders`, and `AdminOrders.tsx`'s plain-update
reject all refund correctly without any of them knowing wallets exist. Any
future status-change path inherits the same correctness.

### Money-holding status

An order **holds money** when its status is `'paid'` *and* its payment method
is the wallet method. This is narrower than the stock rule (`'needs_review'`
or `'paid'`) because a wallet order never passes through verification: it goes
`awaiting_payment -> paid` in one step.

## Data model

All new tables are RLS-protected. `numeric(10,2)` throughout, matching
`orders.total` and `items.price`.

### `wallets`

| Column | Type | Notes |
|---|---|---|
| `user_id` | uuid PK | → `profiles(id) on delete cascade` |
| `balance` | numeric(10,2) not null default 0 | **`check (balance >= 0)`** |
| `updated_at` | timestamptz not null default now() | |

The check constraint is load-bearing: it makes a negative balance impossible
to *store*, so a bug in some future code path is rejected by Postgres rather
than quietly overdrawing a customer.

### `wallet_entries` (append-only journal)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK default gen_random_uuid() | |
| `user_id` | uuid not null | → `profiles(id) on delete cascade` |
| `amount` | numeric(10,2) not null | **signed**: positive = credit, negative = debit |
| `kind` | text not null | `check (kind in ('topup','purchase','refund'))` |
| `order_id` | uuid null | → `orders(id) **on delete set null**` |
| `topup_id` | uuid null | → `topup_requests(id) on delete set null` |
| `note` | text not null default '' | human-readable, survives order deletion |
| `created_at` | timestamptz not null default now() | |

Indexes:

- `wallet_entries_user_created_idx on (user_id, created_at desc)` — the
  history query.
- `wallet_entries_topup_unique on (topup_id) where topup_id is not null` —
  makes double-crediting a top-up impossible.

**No uniqueness on `order_id`.** An order can legitimately be paid, voided,
and paid again; each event is a real journal entry and the arithmetic nets out.
Adding a unique index here would break re-payment.

**`note` is required for legibility after deletion.** `void_order` *deletes*
the order row, and the FK is `on delete set null`, so entries lose their
`order_id`. Each entry therefore stores a readable reference
(`Order #a3f2` — the first 8 characters of the order id) at write time.

### `topup_requests`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK default gen_random_uuid() | |
| `user_id` | uuid not null | → `profiles(id) on delete cascade` |
| `amount` | numeric(10,2) not null | `check (amount > 0 and amount <= 10000)` — see cap note below |
| `payment_method_id` | uuid null | → `payment_methods(id)`; which method they paid into |
| `proof_path` | text not null | object path within the `topup-proofs` bucket |
| `status` | text not null default `'pending'` | `check (status in ('pending','approved','rejected'))` |
| `reviewed_by` | uuid null | → `profiles(id)` |
| `reviewed_at` | timestamptz null | |
| `reject_reason` | text not null default '' | shown to the customer |
| `created_at` | timestamptz not null default now() | |

Index: `topup_requests_one_pending_per_user on (user_id) where status = 'pending'`
— a unique partial index enforcing the one-pending-at-a-time rule in the
database, not just in the UI.

**The ₱10,000 cap is a typo guard, not a policy limit.** Office pantry top-ups
are tens to hundreds of pesos; the cap exists so a slipped keypress (₱50000
instead of ₱500) is rejected at entry rather than becoming an awkward
conversation after an admin approves it. It is a single constant shared by the
check constraint, `request_topup`, and the client-side validator, so raising it
is a one-line change in each.

Table creation order: `topup_requests` before `wallet_entries` (FK dependency).

### Wallet as a payment method

A seeded `payment_methods` row of a **new type `'wallet'`**:

```sql
alter table public.payment_methods drop constraint if exists payment_methods_type_check;
alter table public.payment_methods add constraint payment_methods_type_check
  check (type in ('ewallet','bank','cash','wallet'));
```

(Mirrors `20260703044057_cash_payment.sql`, which added `'cash'` the same way.)

This is what lets `create_order(p_items, p_payment_method_id)` work
**completely unchanged**, reuses the existing checkout method picker, and
gives admins an active/inactive toggle for free via the existing Payments UI.

A guard in the spirit of `20260703084355_protect_last_admin.sql` prevents the
wallet method row from being **deleted** (deactivating stays allowed), since
deleting it would strand `pay_order_with_wallet` and orphan the checkout path.

### Wallet row provisioning

Three layers, because a credit can never be applied to a missing row:

1. The migration **backfills** `wallets` for every existing `profiles` row.
2. `handle_new_user()` is extended to insert a `wallets` row alongside the
   profile.
3. The internal credit/debit helper does `insert ... on conflict do nothing`
   before locking, as belt-and-braces.

## Triggers

### `sync_order_wallet` (AFTER UPDATE on `public.orders`)

Fires only when `old.status is distinct from new.status`.

**Entering `'paid'`** (and the order's payment method type is `'wallet'`):

```sql
update public.wallets
set balance = balance - v_total, updated_at = now()
where user_id = new.user_id and balance >= v_total;
if not found then
  raise exception 'insufficient wallet balance';
end if;
insert into public.wallet_entries (user_id, amount, kind, order_id, note)
values (new.user_id, -v_total, 'purchase', new.id, 'Order #' || left(new.id::text, 8));
```

The guarded-update-plus-not-found shape is taken directly from
`sync_order_stock`, and for the same reason: it produces a specific, friendly
error instead of a raw constraint violation. Raising aborts the transaction,
which rolls back the status change too — **an order can never sit in `'paid'`
without the money having actually moved.**

**Leaving `'paid'`** — refund the amount **actually outstanding**, not the
order total:

```sql
select coalesce(-sum(amount), 0) into v_outstanding
from public.wallet_entries where order_id = new.id;
if v_outstanding > 0 then
  update public.wallets set balance = balance + v_outstanding, updated_at = now()
  where user_id = new.user_id;
  insert into public.wallet_entries (user_id, amount, kind, order_id, note)
  values (new.user_id, v_outstanding, 'refund', new.id,
          'Refund · order #' || left(new.id::text, 8));
end if;
```

Computing the refund from the ledger rather than from `orders.total` is what
keeps this correct in the awkward cases: an order that was never wallet-paid
nets zero and is skipped, an already-refunded order nets zero and is not
refunded twice, and the trigger stays right even if an admin later edits or
deactivates the wallet payment method.

### `release_order_wallet` (BEFORE DELETE on `public.orders`)

The same refund block but reading `old` throughout, keyed on
`old.status = 'paid'`. It runs **before** the delete, so the entry is inserted
while the order row still exists; the FK then nulls `order_id`, and the `note`
carries the readable reference forward.

### Lock ordering

Postgres fires same-timing triggers in **name order**, so on `public.orders`
the effective sequence is `sync_order_stock` then `sync_order_wallet` — i.e.
locks are taken **order → items → wallet**. (The new trigger names are chosen
so this ordering is stable and obvious rather than incidental.)

Which of items/wallet comes first does not affect correctness: both run inside
the same transaction as the status change, so a failure in either aborts
everything and rolls the other back. What matters is that the order is **the
same on every path**, which it is, because every order-status change goes
through this one trigger pair. That consistency is what rules out deadlock
between two concurrent checkouts.

## RPCs

All `security definer set search_path = public`, matching existing style.

| Function | Caller | Behavior |
|---|---|---|
| `request_topup(p_amount numeric, p_payment_method_id uuid, p_proof_path text) returns uuid` | customer | Validates `auth.uid()`, `0 < amount <= 10000`, and that `p_proof_path` is under the caller's own folder. Inserts a `pending` row with proof already attached. The unique partial index rejects a second pending request with a friendly message. |
| `approve_topup(p_id uuid)` | admin | `is_admin()` check. Locks the request `for update`, requires `status='pending'`. Locks the wallet row, credits `amount`, inserts a `topup` entry, sets `status='approved'`, `reviewed_by=auth.uid()`, `reviewed_at=now()`. |
| `reject_topup(p_id uuid, p_reason text)` | admin | `is_admin()` check. Locks the request, requires `status='pending'`, sets `status='rejected'` + `reject_reason`. **Writes no ledger entry.** |
| `pay_order_with_wallet(p_order_id uuid)` | customer | Validates ownership (`user_id = auth.uid()`), `status='awaiting_payment'`, and that the order's payment method is type `'wallet'`. Then simply `update orders set status='paid'` — the trigger does all the money. |

`pay_order_with_wallet` requiring the method to be the wallet method is a
deliberate guard: it stops a QR-method order from being silently paid out of
the balance.

**No `confirm_order` refactor is needed.** Because the debit lives in a trigger
on the status transition, `pay_order_with_wallet` never has to call
`confirm_order` (which would fail its `is_admin() or service_role` check when
invoked as a customer). This also avoids introducing an unguarded
`security definer` helper that would need explicit `revoke execute` handling —
the repo otherwise relies on default PUBLIC execute grants.

## RLS policies

| Table | Policy |
|---|---|
| `wallets` | select: own row or `is_admin()`. **No client insert/update/delete** — balance moves only through security-definer functions and triggers. |
| `wallet_entries` | select: own rows or `is_admin()`. No client writes. |
| `topup_requests` | select: own rows or `is_admin()`. Insert/update: none for clients — `request_topup` / `approve_topup` / `reject_topup` only. |

Storage bucket **`topup-proofs`** (private), mirroring `receipts`:

- insert: authenticated, path's first folder = `auth.uid()`
- update: same (re-upload own)
- select: own folder or `is_admin()`

## Customer UX

### `CustomerLayout`

New `src/pages/CustomerLayout.tsx`, mirroring `AdminLayout`'s markup and
Tailwind classes, wrapping `/store`, `/orders`, `/wallet`, `/settings` with an
`<Outlet/>`.

Differences from the admin bar: the customer side is mobile-first throughout,
so the bar shows at **all** widths (no `md:hidden`), constrained to
`max-w-md mx-auto` so it lines up with the `app-frame` content column on
desktop. It keeps the admin bar's safe-area handling:
`pb-[max(0.5rem,env(safe-area-inset-bottom))]`.

Tabs: **Store** (`/store`), **My orders** (`/orders`), **Top up** (`/wallet`),
**Settings** (`/settings`), using `lucide-react` icons at `size-6`
`strokeWidth={2.5}`, active state `text-brand-700 font-bold`.

`/cart` and `/pay/:orderId` stay **outside** the shell — focused full-screen
flows with their own back arrow. A tab bar during payment invites mis-taps
mid-transaction.

### Collisions to fix

- `CartBar` is `fixed bottom-[max(1rem,env(safe-area-inset-bottom))]` and
  would sit underneath the new nav. It is lifted to clear the bar.
- `Store`'s `pb-28` grows so content clears both the cart bar and the nav.
- The `Store` header loses its `My orders` / `Admin` / `Sign out` links — the
  nav and Settings own those now. It keeps the logo, search, and category chips.

### `/wallet` — Top up tab

- **Balance card**: the large brand-colored figure, styled after `Pay.tsx`'s
  amount-due card.
- **Top up flow**, a phased state machine reusing `Pay.tsx`'s `Phase` shape:
  1. Amount — preset chips (₱100 / ₱200 / ₱500) plus a custom input.
  2. Method — the active **non-wallet** methods; selecting one shows its QR and
     account name, or the cash instructions, reusing `Pay.tsx`'s presentation.
  3. *I've paid — upload proof* → `compressImage` → upload to
     `topup-proofs/{user_id}/{uuid}.jpg` → `request_topup(...)`.
- **Pending state**: a card showing the amount and submitted time, and the
  `Top up` button disabled with an explanation (one pending request at a time).
- **History**: newest first. Because **rejected top-ups write no ledger
  entry**, the list is a client-side merge of `wallet_entries` with
  pending/rejected `topup_requests`, sorted by `created_at`. Without the merge
  a rejection would silently vanish and the customer would never learn why.
  Rejected rows render muted with the admin's reason.

### `/settings`

Profile card (avatar, full name, email from `useAuth`), `Admin console` link
when `profile.is_admin`, Privacy, Terms, and Sign out.

### Checkout integration

`src/pages/Cart.tsx`:

- The wallet method renders with a `Wallet` icon; its detail line shows the
  live balance (`Balance ₱240`).
- When `balance < total` it renders **disabled** with *Not enough — top up*
  linking to `/wallet`, and is excluded from the existing
  "auto-select `m[0]`" behavior so the customer is never silently parked on an
  unusable method.
- Ordering: the wallet appears first when affordable.
- Placing the order still calls `create_order` unchanged, then navigates to
  `/pay/:orderId`.

`src/pages/Pay.tsx` branches on `method.type === 'wallet'`: no QR, no upload.
It shows *Pay ₱120 from your balance · ₱120 left after* with a confirm button
calling `pay_order_with_wallet`, then re-fetches the order and falls into the
**existing** paid-state UI and return-to-store countdown.

## Admin UX

### Top-ups queue

`AdminLayout`'s own code comments note the mobile bottom bar is "already at its
width budget," so a seventh tab does not fit. Following the pattern established
by recent commits (`Rank buyers by total purchase on a sales inner page`,
`Give the projected sales tile its chevron affordance`):

- **Dashboard tile** — *Top-ups awaiting approval · 3* with a chevron
  affordance, linking to the inner page. Admins on a phone reach it from where
  they already land.
- **Sidebar entry** in `AdminLayout`'s `NAV` with `mobileHidden: true`.

`src/pages/admin/Topups.tsx` at `/admin/topups`:

- Filter: pending (default) / all.
- Each row: customer name + email, amount, submitted time, the method they paid
  into, and a proof thumbnail that opens full-size. Proofs are private, so the
  view fetches **signed URLs** the same way `AdminOrders.tsx` already does for
  receipts.
- **Approve** goes through `ConfirmDialog` — it moves real money.
- **Reject** collects the reason the customer will see.

### Users page

`src/pages/admin/Users.tsx` gains a **read-only** balance column. Strictly
display: no adjustment controls, consistent with the approve/reject-only
decision.

## Types

`src/types.ts` additions:

```ts
export interface Wallet { user_id: string; balance: number; updated_at: string }

export type WalletEntryKind = 'topup' | 'purchase' | 'refund'

export interface WalletEntry {
  id: string; user_id: string; amount: number; kind: WalletEntryKind
  order_id: string | null; topup_id: string | null
  note: string; created_at: string
}

export type TopupStatus = 'pending' | 'approved' | 'rejected'

export interface TopupRequest {
  id: string; user_id: string; amount: number
  payment_method_id: string | null; proof_path: string
  status: TopupStatus; reviewed_by: string | null; reviewed_at: string | null
  reject_reason: string; created_at: string
}
```

`PaymentMethod['type']` widens to `'ewallet' | 'bank' | 'cash' | 'wallet'`.

## Error handling

- **Insufficient balance at pay time.** The client never trusts its cached
  balance; the trigger's guarded update is authoritative. If the balance moved
  between render and tap, the server's refusal is surfaced as *Not enough
  balance* with a top-up link.
- **Double-approved top-up.** Blocked twice: the `status='pending'` guard and
  the unique index on `wallet_entries(topup_id)`.
- **Second pending top-up.** Rejected by the unique partial index; the UI
  already disables the button, so this is the server-side backstop.
- **Upload failures.** Same handling as `Pay.tsx` — `compressImage`, 5MB cap
  after compression, inline error with retry.
- **Missing wallet row.** Impossible by the three-layer provisioning above.
- **Anthropic/AI is not involved** anywhere in the wallet path. A wallet
  payment cannot be blocked by an AI outage.

## Testing

### Vitest (runs in `npm test` today)

New `src/lib/wallet.ts` + `src/lib/wallet.test.ts`, matching the existing
`src/lib/*.test.ts` style — pure functions only:

- `canAfford(balance, total)` including exact-balance equality.
- Entry sign/label formatting for each `kind`.
- Top-up amount validation: positive, at or below the ₱10,000 cap, parsing of the custom input
  (empty, non-numeric, decimals, leading zeros).
- The history merge: ledger entries plus pending/rejected requests, sorted by
  `created_at`, with ties stable.

### pgTAP (`npm run test:db`)

`supabase/tests/wallet.test.sql`, run against a local `supabase start`. This is
**new tooling for this repo** — no DB test harness exists today — and it is
part of the scope. It covers the invariants that unit tests structurally
cannot:

1. An approved top-up credits the balance and writes exactly one `topup` entry.
2. An order entering `'paid'` on the wallet method debits the balance and
   writes a `purchase` entry.
3. An overdraft attempt **raises and rolls back both** the balance and the
   order status — the order must not be left in `'paid'`.
4. `void_order` on a wallet-paid order refunds the exact outstanding amount,
   once, and returns stock.
5. The standing invariant `balance = sum(wallet_entries.amount)` holds after a
   full top-up → purchase → void → re-pay sequence.
6. RLS: a customer cannot select another customer's `wallets` or
   `wallet_entries` rows.

### Manual

One pass on a mobile viewport covering the four tabs, the top-up flow end to
end, and a wallet checkout.

## Out of scope

- Manual admin balance adjustments (credits/debits outside the top-up flow).
- Editing the amount during top-up approval.
- AI verification of top-up proofs — approval is manual by decision.
- Wallet-to-wallet transfers, expiry, or negative-balance credit.
