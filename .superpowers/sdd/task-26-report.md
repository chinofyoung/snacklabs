# Task 26: Add CASH payment support (backend only)

## Migration

`supabase/migrations/20260703044057_cash_payment.sql`:

```sql
alter table public.payment_methods drop constraint if exists payment_methods_type_check;
alter table public.payment_methods add constraint payment_methods_type_check check (type in ('ewallet','bank','cash'));
alter table public.payment_methods alter column qr_image_url drop not null;
```

Applied via `supabase db query --linked --file supabase/migrations/20260703044057_cash_payment.sql`,
then tracked with an `insert into supabase_migrations.schema_migrations (version, name, statements)`
row (version `20260703044057`, name `cash_payment`) matching the existing table's format.

Verified:
- `pg_get_constraintdef` on `payment_methods_type_check` → `CHECK ((type = ANY (ARRAY['ewallet'::text, 'bank'::text, 'cash'::text])))`
- `information_schema.columns` for `qr_image_url` → `is_nullable = YES`
- `schema_migrations` now lists `20260703044057 | cash_payment` alongside the prior 4 rows.

No cash payment_methods row was inserted (left to frontend/admin).

## Verdict TDD (supabase/functions/_shared/verdict.ts + verdict.test.ts)

Added a `decideOrderStatus (cash mode)` describe block first with 6 cases (exact match pays,
overpayment pays, underpayment → needs_review, fail/unsure → needs_review, null amount →
needs_review, refAlreadyUsed ignored for cash).

**RED**: `npx vitest run supabase/functions/_shared/verdict.test.ts` → 2 failed / 9 passed
(overpayment and ref-reuse-ignored cases failed against the old 3-arg implementation, which
had no cash branch and unconditionally applied the ref-reuse and exact-match checks).

**GREEN**: added `isCash = false` 4th parameter to `decideOrderStatus`. Non-cash path unchanged
(refAlreadyUsed check first, then exact-match within 0.009 tolerance). Cash path: pass if
`verdict === 'pass' && amount !== null && amount >= orderTotal - 0.009`, ignoring refAlreadyUsed
entirely. Re-ran: 11/11 passed.

Full suite: `npm run test` → 4 test files, 24 passed (18 pre-existing + 6 new cash tests).

## verify-payment cash branch (supabase/functions/verify-payment/index.ts)

Introduced `isCash = method?.type === 'cash'` and `model = isCash ? 'claude-sonnet-5' : 'claude-opus-4-8'`
right after the mediaType detection. Built `promptText` as a ternary:

- **Cash prompt**: identifies denominations (₱1000/500/200/100/50/20 notes, ₱20/10/5/1 coins),
  sums the clearly-visible total, verdict pass only if genuine cash AND total >= amount due,
  fail if clearly short or not cash, unsure if blurry/ambiguous; extracted.amount = counted total,
  recipient/reference/timestamp forced to null.
- **Non-cash prompt**: unchanged verbatim from the original receipt-screenshot rubric.

The Anthropic call now uses `model` and spreads `{ thinking: { type: 'disabled' } }` only when
`isCash` is true; `VERDICT_SCHEMA` and `output_config` are shared/untouched for both branches.

Cost logging: `computeCost(usage ?? {}, model)` (previously hardcoded to `'claude-opus-4-8'`) — so
cash calls log at Sonnet rates, receipts continue at Opus rates, both landing in the same
`ai_usage` insert.

Reference-reuse check is now guarded by `!isCash` so it's skipped entirely for cash (no query
issued), and `decideOrderStatus` is called as `decideOrderStatus(verdict, Number(order.total), refAlreadyUsed, isCash)`.
Everything else — receipt_path owner-binding check, storage download/base64, `parkForReview`,
`confirm_order` RPC on paid — is untouched.

## Gate

```
npm run test   → 4 test files, 24 passed
npm run build  → tsc -b && vite build, built in 249ms, no errors
```

## Deploy

```
export SUPABASE_ACCESS_TOKEN=<redacted>
supabase functions deploy verify-payment

WARNING: Docker is not running
Uploading asset (verify-payment): supabase/functions/verify-payment/index.ts
Uploading asset (verify-payment): supabase/functions/_shared/pricing.ts
Uploading asset (verify-payment): supabase/functions/_shared/verdict.ts
{"project_ref":"aztgvfrayjbhtxfvsram","functions":["verify-payment"],"dashboard_url":"...","message":"Deployed Functions."}
```

Function was not invoked/executed per instructions.
