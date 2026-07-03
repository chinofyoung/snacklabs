# Task 7 Report: Payment verdict logic (TDD) + verify-payment Edge Function

## Status: Implemented

## Files created

- `supabase/functions/_shared/verdict.test.ts` — Vitest unit tests for `decideOrderStatus`
- `supabase/functions/_shared/verdict.ts` — pure verdict logic + `AiVerdictResult` type
- `supabase/functions/verify-payment/index.ts` — Deno Edge Function

All code taken verbatim from `.superpowers/sdd/task-7-brief.md`.

## TDD evidence

### Step 1-2: RED

Created `verdict.test.ts` first (importing non-existent `./verdict`), then ran `npm run test`:

```
FAIL  supabase/functions/_shared/verdict.test.ts [ supabase/functions/_shared/verdict.test.ts ]
Error: Cannot find module './verdict' imported from /Users/chinoyoung/snacklabs/supabase/functions/_shared/verdict.test.ts

 Test Files  1 failed | 2 passed (3)
      Tests  8 passed (8)
```

Confirmed failure was the expected "cannot find `./verdict`" error, and the prior 8 tests were unaffected/still passing.

### Step 3-4: GREEN

Implemented `verdict.ts` verbatim from the brief. Re-ran `npm run test`:

```
 Test Files  3 passed (3)
      Tests  13 passed (13)
```

13 = prior 8 + new 5 verdict tests, all passing.

### Step 5: Edge Function

Implemented `supabase/functions/verify-payment/index.ts` verbatim from the brief (model string `claude-opus-4-8`, `output_config: { format: { type: 'json_schema', schema: VERDICT_SCHEMA } }` used exactly as specified).

Verified `npm run test` still shows 3 files / 13 tests (vitest correctly ignores `index.ts` since it only matches `_shared/**/*.test.ts` sources, and `verdict.ts` has no Deno/npm imports).

## Deploy output

```
supabase functions deploy verify-payment
```

```
WARNING: Docker is not running
Uploading asset (verify-payment): supabase/functions/verify-payment/index.ts
Uploading asset (verify-payment): supabase/functions/_shared/verdict.ts
{"project_ref":"aztgvfrayjbhtxfvsram","functions":["verify-payment"],"dashboard_url":"https://supabase.com/dashboard/project/aztgvfrayjbhtxfvsram/functions","message":"Deployed Functions."}
```

Deploy succeeded (Docker-not-running warning is benign — no local container needed for asset upload deploy).

## Secrets list (names only)

```
SUPABASE_ANON_KEY
SUPABASE_DB_URL
SUPABASE_JWKS
SUPABASE_PUBLISHABLE_KEYS
SUPABASE_SECRET_KEYS
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_URL
```

**`ANTHROPIC_API_KEY` is NOT present.** Per instructions this does not block progress — noted as a concern below. The function will fail at the Anthropic call until this secret is set, but it will gracefully fall back to `needs_review` via the `parkForReview` catch handler rather than crashing (per the brief's error handling design) — so the endpoint itself won't 500, it will just always route to manual review until the key is added.

## Curl sanity check

```
curl -s -o /dev/null -w "%{http_code}" -X POST https://aztgvfrayjbhtxfvsram.supabase.co/functions/v1/verify-payment
```

Result: `401` (as expected — no auth header supplied).

## Final verification

`npm run test`:
```
 Test Files  3 passed (3)
      Tests  13 passed (13)
```

`npm run build`:
```
✓ 128 modules transformed.
dist/index.html                   0.45 kB │ gzip:   0.29 kB
dist/assets/index-kfPOms3k.css   22.49 kB │ gzip:   5.09 kB
dist/assets/index-Zo7FYgda.js   445.89 kB │ gzip: 128.82 kB
✓ built in 147ms
```

Both pass cleanly.

## Concerns

1. **`ANTHROPIC_API_KEY` secret is missing** from the linked Supabase project's secrets. The deployed `verify-payment` function will not be able to call the Anthropic API until this is set (via `supabase secrets set ANTHROPIC_API_KEY=...`). Until then, every invocation will fall through to `needs_review` with reason `"AI verification unavailable: ..."`. This does not block Task 7 completion (code/tests/deploy all verified) but must be resolved before Task 8's end-to-end flow can produce a real `paid` verdict. The controller is understood to be obtaining this key separately.
2. Full end-to-end testing (real receipt upload → AI verdict → order status update) is deferred to Task 8 per the brief, since it requires the upload UI and a real JWT-authenticated request.

## Fix round 1

Addressed two code review findings against `supabase/functions/verify-payment/index.ts`.

### Finding 1 (Important) — ref-reuse check fails open on query error

Previously the reference-reuse count query destructured only `{ count }`; a DB error silently yielded `count = null` → `refAlreadyUsed = false` → a replayed screenshot could be paid. Fixed to fail closed by also destructuring the query error and parking the order for manual review if it's present:

```ts
if (verdict.extracted.reference) {
  const { count, error: refErr } = await admin
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'paid')
    .neq('id', order_id)
    .eq('ai_verdict->extracted->>reference', verdict.extracted.reference)
  if (refErr) return parkForReview('reference reuse check unavailable: ' + refErr.message, verdict)
  refAlreadyUsed = (count ?? 0) > 0
}
```

### Finding 2 (hardening) — bind receipt_path to the order owner

Added an ownership check immediately after the order is fetched and its status validated, before the `verifying` status update, to ensure the client-supplied `receipt_path` actually belongs to the order's owner (receipts are uploaded to `${user_id}/${order_id}.jpg`):

```ts
if (orderErr || !order) return json({ error: 'order not found' }, 404)
if (!['awaiting_payment', 'needs_review'].includes(order.status)) {
  return json({ error: `order is ${order.status}` }, 409)
}
if (!receipt_path.startsWith(`${order.user_id}/`)) {
  return json({ error: 'invalid receipt path' }, 403)
}
```

### Test output

```
npm run test

 RUN  v4.1.9 /Users/chinoyoung/snacklabs

 Test Files  3 passed (3)
      Tests  13 passed (13)
   Start at  11:30:28
   Duration  151ms (transform 76ms, setup 0ms, import 117ms, tests 11ms, environment 0ms)
```

No test changes were needed — the shared verdict module (`_shared/verdict.ts`) was untouched by this fix.

### Build output

```
npm run build

> scaffold@0.0.0 build
> tsc -b && vite build

vite v8.1.2 building client environment for production...
✓ 128 modules transformed.
dist/index.html                   0.45 kB │ gzip:   0.29 kB
dist/assets/index-BBqCe87C.css   22.76 kB │ gzip:   5.13 kB
dist/assets/index-98njYalT.js   445.89 kB │ gzip: 128.82 kB

✓ built in 152ms
```

### Deploy confirmation

```
/opt/homebrew/bin/supabase functions deploy verify-payment

WARNING: Docker is not running
Uploading asset (verify-payment): supabase/functions/verify-payment/index.ts
Uploading asset (verify-payment): supabase/functions/_shared/verdict.ts
{"project_ref":"aztgvfrayjbhtxfvsram","functions":["verify-payment"],"dashboard_url":"https://supabase.com/dashboard/project/aztgvfrayjbhtxfvsram/functions","message":"Deployed Functions."}
```

Deployed successfully to the `aztgvfrayjbhtxfvsram` project. Both findings are resolved in the live Edge Function.
