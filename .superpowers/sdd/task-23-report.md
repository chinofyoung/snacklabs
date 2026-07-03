# Task 23 — Restock auth fix + Sonnet model switch

## Fix 1: auth bug in analyze-shelf (root cause of "unauthenticated")

`supabase/functions/analyze-shelf/index.ts` called `userClient.auth.getUser()` with no
argument. In a Deno Edge Function there is no server-side session store, so the
Supabase client has nothing to look up even though `global.headers.Authorization` was
set on the client — `getUser()` doesn't read that header implicitly. It always
returned `user: null`, so every restock request 401'd with `unauthenticated`, even
for valid admins.

Fix: extract the bearer token from the incoming request and pass it explicitly:

```ts
const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '')
const { data: { user } } = await userClient.auth.getUser(token)
if (!user) return json({ error: 'unauthenticated' }, 401)
```

The subsequent `profile.is_admin` check was left unchanged.

## Fix 2: switch restock analysis to Sonnet 5, disable thinking

In the `anthropic.messages.create({...})` call in `analyze-shelf/index.ts`:

- `model: 'claude-opus-4-8'` → `model: 'claude-sonnet-5'`
- Added `thinking: { type: 'disabled' }` — Sonnet 5 runs adaptive thinking by default
  when `thinking` is omitted, which would add token cost to this vision-extraction
  call for no benefit.
- Kept `output_config: { format: { type: 'json_schema', schema: DETECTIONS_SCHEMA } }`
  and `max_tokens: 4096` unchanged. No temperature/top_p/top_k added (rejected on
  Sonnet 5).

## Fix 3: model-aware pricing

`supabase/functions/_shared/pricing.ts` was refactored from a single hardcoded
opus-4-8 `RATES` constant to a `MODEL_RATES` lookup keyed by model ID:

| Model | input $/1M | output $/1M | cache read $/1M | cache write $/1M |
|---|---|---|---|---|
| claude-opus-4-8 | 5 | 25 | 0.5 | 6.25 |
| claude-sonnet-5 | 3 | 15 | 0.3 | 3.75 |

`USD_TO_PHP = 58.50` unchanged. New signature:

```ts
export function computeCost(u: Usage, model: string): { cost_usd: number; cost_php: number }
```

Unknown model strings fall back to the opus-4-8 rates (safe over-estimate) rather
than throwing.

`pricing.test.ts` updated: all existing assertions now pass `'claude-opus-4-8'`
explicitly; added a `claude-sonnet-5` case (1000 in @ $3/M + 500 out @ $15/M =
0.003 + 0.0075 = 0.0105) and an unknown-model fallback case.

## Fix 4: call sites updated

- `verify-payment/index.ts`: `computeCost(usage ?? {})` → `computeCost(usage ?? {}, 'claude-opus-4-8')`
- `analyze-shelf/index.ts`: `computeCost(usage ?? {})` → `computeCost(usage ?? {}, 'claude-sonnet-5')`

## Verification

- `npm run test` — 4 test files, **18 passed** (16 pre-existing + 2 new pricing cases).
- `npm run build` — `tsc -b && vite build` completed clean, no type errors.

## Deploy

Both functions deployed via `/opt/homebrew/bin/supabase functions deploy <name>`
(Docker not running — warning only, deploy succeeded via remote bundling):

- `analyze-shelf` — deployed, uploaded `index.ts` + `_shared/pricing.ts`.
- `verify-payment` — deployed, uploaded `index.ts` + `_shared/pricing.ts` + `_shared/verdict.ts`.

Both returned `"message":"Deployed Functions."` for project `aztgvfrayjbhtxfvsram`.

No live Anthropic calls were made — functions were not invoked/executed.
