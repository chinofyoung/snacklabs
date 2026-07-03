# Task 28a — app_settings table + Haiku pricing

## Step 1 — Migration: app_settings

- File: `supabase/migrations/20260703044303_app_settings.sql` (created via `supabase migration new app_settings`)
- Singleton table `public.app_settings` (id boolean PK, `payment_ai_enabled` bool default true, `payment_ai_model` text default `claude-opus-4-8` with check constraint restricting to `claude-haiku-4-5` / `claude-sonnet-5` / `claude-opus-4-8`, `updated_at`, singleton check `id = true`).
- RLS enabled with admin-only read/write policies using existing `public.is_admin()`.
- Applied via `supabase db query --linked --file supabase/migrations/20260703044303_app_settings.sql` — succeeded, no errors.
- Tracked via `insert into supabase_migrations.schema_migrations (version, name) values ('20260703044303', 'app_settings');` — confirmed present in `select version, name from supabase_migrations.schema_migrations order by version;` alongside existing rows (format matched: version + name).

### Verification

`select id, payment_ai_enabled, payment_ai_model from public.app_settings;` returned exactly one row:

```
id: true, payment_ai_enabled: true, payment_ai_model: "claude-opus-4-8"
```

## Step 2 — Haiku pricing

- `supabase/functions/_shared/pricing.ts`: added `claude-haiku-4-5` entry to `MODEL_RATES` (input $1/M, output $5/M, cacheRead $0.1/M, cacheWrite $1.25/M). Existing `claude-opus-4-8` / `claude-sonnet-5` entries and the `DEFAULT_RATES` fallback (still opus-4-8) untouched.
- `supabase/functions/_shared/pricing.test.ts`: added `computeCost (claude-haiku-4-5)` describe block asserting 1000 input @ $1/M + 500 output @ $5/M = 0.0035 USD, and `cost_php = 0.0035 * USD_TO_PHP`.

## Gate results

- `npm run test`: 4 test files, 25 tests passed (existing 21 tests + 4 new haiku assertions... actually 3 new assertions in 1 new test case — count includes prior suites unaffected).
- `npm run build`: clean — `tsc -b && vite build` succeeded, no errors.

## Files changed

- `supabase/migrations/20260703044303_app_settings.sql` (new)
- `supabase/functions/_shared/pricing.ts`
- `supabase/functions/_shared/pricing.test.ts`

Not touched (per instructions): `verify-payment/index.ts`, `analyze-shelf/index.ts`, frontend. Note: `verify-payment/index.ts` and `_shared/verdict.ts`/`verdict.test.ts` appeared as already-modified in `git status` at task start (another change in flight) — left untouched by this task.
