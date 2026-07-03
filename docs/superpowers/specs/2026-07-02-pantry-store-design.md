# SnackLabs — Office Pantry Store: Design Spec

**Date:** 2026-07-02
**Status:** Approved by user (brainstorming session)

## Overview

A web app for a mini office pantry/store. Customers browse items and pay via
QR (e-wallet or bank) on their phones; an AI system verifies payment
screenshots automatically. Admins manage inventory and payment methods, and
can restock by photographing the shelf — Claude identifies items and counts.

- **Customer side:** mobile-first.
- **Admin side:** responsive (desktop + mobile).
- **Stack:** Vite + React + Tailwind CSS, Supabase (Postgres, Auth, Storage,
  Edge Functions), Anthropic API (Claude vision) called only from Edge
  Functions.
- **Currency:** Philippine Pesos (₱). Payment methods: GCash QR and bank
  (InstaPay/QR Ph) QR, uploaded by admin as images.

## Architecture

Single Vite + React SPA with two route trees:

- `/` — customer store (requires sign-in)
- `/admin` — admin panel (requires `is_admin`)

Supabase provides Google OAuth, Postgres with RLS, image storage, and two
Edge Functions that hold the Anthropic API key server-side:

1. `verify-payment` — reads a payment receipt screenshot against an order.
2. `analyze-shelf` — detects items + counts from a shelf photo.

The Anthropic key never ships to the browser. Clients can never set an order
to `paid` directly (RLS); only the Edge Function (service role) can.

## Auth & roles

- Supabase Google OAuth, restricted to `@goabroad.com` — enforced
  server-side by a DB trigger that rejects other domains on profile creation.
- First sign-in auto-creates a `profiles` row.
- Admins: `profiles.is_admin` flag. Bootstrap the first admin via Supabase
  dashboard; admins can promote others from the admin UI.

## Data model (all tables RLS-protected)

| Table | Columns | Access |
|---|---|---|
| `profiles` | id (=auth uid), full_name, avatar_url, email, is_admin | read: all signed-in; write: owner; is_admin: admins only |
| `items` | id, name, price, stock, image_url, category, low_stock_threshold, is_active (soft delete) | read: signed-in; write: admins |
| `payment_methods` | id, label, type (ewallet/bank), qr_image_url, account_name, account_number, is_active | read: signed-in (number masked client-side); write: admins |
| `orders` | id, user_id, total, status, payment_method_id, receipt_image_url, ai_verdict (JSON), created_at | customer: own rows; admins: all |
| `order_items` | order_id, item_id, qty, price_at_purchase (snapshot) | follows orders |
| `restock_sessions` | id, admin_id, photo_url, ai_result (JSON), status (pending_review/applied/discarded), created_at | admins only |

**Order status flow:** `awaiting_payment` → `verifying` → `paid` |
`needs_review` | `cancelled`.

**Storage buckets:** `item-images`, `qr-codes` (public-read to signed-in),
`receipts` (private: uploader + admins), `restock-photos` (admins).

**Integrity rule:** stock is decremented by a Postgres function in a single
transaction when an order is confirmed — never client-side. Concurrent
purchases of the last unit cannot both succeed.

## Customer screens (mobile-first)

1. **Store** — sticky search + category chips; item cards (photo, name,
   price, stock badge; out-of-stock greyed). Floating cart bar (count +
   total).
2. **Cart & checkout** — qty steppers, total → choose payment method →
   full-screen QR with account name + amount → "I've paid — upload
   screenshot".
3. **Payment upload** — camera/picker, preview, submit → live status:
   *Verifying…* → *Paid ✓* or *Sent to admin for review*.
4. **My orders** — history with statuses; `needs_review` orders show reason.

## Admin screens (sidebar on desktop, bottom tabs on mobile)

1. **Dashboard** — today's sales, orders needing review, low-stock items.
2. **Items** — list with inline stock edit; add/edit form (photo, name,
   price, category, low-stock threshold).
3. **AI Restock** — take/upload shelf photo → Claude detection → review
   screen: each detection is an editable row (`matched: Piattos, +12` /
   `new item: Hansel, suggested ₱15`) → adjust → **Apply** (restocks matched
   + creates new items in one transaction). Nothing changes until Apply.
4. **Orders** — all orders, filterable; `needs_review` queue shows receipt
   image beside the AI's reading; approve/reject in one tap.
5. **Payment methods** — add/edit QR images + account details, toggle active.

## AI flows

### verify-payment (Edge Function)

Input: order id + receipt image. Sends order details + image to Claude
vision with a strict rubric:

- Amount matches order total?
- Recipient name/number matches the chosen payment method?
- Reference number present and **unused** (checked against previous orders'
  `ai_verdict.extracted.ref` — blocks screenshot reuse)?

Claude returns structured JSON: `{verdict: pass|fail|unsure, extracted:
{amount, recipient, ref, timestamp}, reason}`.

- **pass** → mark `paid` + decrement stock (one transaction).
- **fail / unsure** → `needs_review`, stock untouched, appears in admin queue.

### analyze-shelf (Edge Function)

Input: shelf photo. Claude receives the current item catalog (names + ids)
as context and returns detected products with counts, each flagged
`matched` (item id) or `new` (suggested name + price). Result saved to
`restock_sessions` and rendered in the admin review screen.

## Error handling

- Anthropic API down/timeout: orders park in `needs_review` with a note
  (manual verification path); restock shows retry. Nothing lost or stuck.
- Stock reaches 0 between add-to-cart and payment: checkout re-validates and
  informs the customer before paying.
- Uploads capped ~5MB; images compressed client-side before upload.

## Testing

- Vitest: cart math, stock transaction function, Edge Function verdict
  handling (mocked Anthropic responses).
- RLS policies exercised with Supabase test helpers.
- Manual E2E pass on a mobile viewport before completion.

## Deployment

- Frontend: any static host (Vercel/Netlify).
- Supabase: DB, auth, storage, both Edge Functions.
- Secrets (`ANTHROPIC_API_KEY`): Supabase function config only.

## UI direction

Modern and friendly: clean neutral base, one warm accent color, rounded
cards, large tap targets, subtle motion on add-to-cart. Implementation will
use the frontend-design skill for an intentional (non-template) look.
