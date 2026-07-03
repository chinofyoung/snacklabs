# Task 17 — AI Usage Cost Tracking

## 1. Migration

**File:** `supabase/migrations/20260703031329_ai_usage.sql` (created via `supabase migration new ai_usage`)

```sql
create table public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  fn text not null check (fn in ('verify-payment','analyze-shelf')),
  order_id uuid references public.orders(id),
  session_id uuid references public.restock_sessions(id),
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_creation_tokens integer not null default 0,
  cost_usd numeric(12,6) not null default 0,
  cost_php numeric(12,4) not null default 0,
  created_at timestamptz not null default now()
);
alter table public.ai_usage enable row level security;
create policy "ai_usage admin read" on public.ai_usage for select to authenticated using (public.is_admin());
```

**Apply method:** `db push` is broken on this machine, so applied via:
```
supabase db query --linked --file supabase/migrations/20260703031329_ai_usage.sql
```

**Migration tracking:** Checked `select version from supabase_migrations.schema_migrations order by version;` first — found the existing init migration tracked only by its `20260702030220` version prefix (matching the filename timestamp, no `name` column value relied upon). Inserted the new migration's tracking row the same way:
```sql
insert into supabase_migrations.schema_migrations (version, name)
values ('20260703031329', 'ai_usage') on conflict do nothing;
```
Verified `schema_migrations` now lists both `20260702030220` and `20260703031329`.

**Verification:** `select count(*) from public.ai_usage;` → `0`, no error. Table exists in the linked project's public schema.

## 2. Pricing module — TDD

**RED:** Wrote `supabase/functions/_shared/pricing.test.ts` first (importing from `./pricing`, which did not yet exist). Ran `npm run test -- pricing` — failed with `Cannot find module './pricing'`, confirming the test fails for the right reason (missing implementation, not a typo).

**GREEN:** Created `supabase/functions/_shared/pricing.ts` implementing `USD_TO_PHP = 58.50` and `computeCost(usage)` using claude-opus-4-8 list pricing ($5/M input, $25/M output, $0.5/M cache read, $6.25/M cache write). Re-ran `npm run test -- pricing` — all 3 tests passed.

## 3. Edge Function insertion points

**`supabase/functions/verify-payment/index.ts`:**
- Import: `import { computeCost } from '../_shared/pricing.ts'`
- Hoisted `let usage: Anthropic.Messages.Usage | undefined` outside the try block (alongside `let verdict: AiVerdictResult`), since `response` is scoped inside the try.
- Set `usage = response.usage` right after `verdict` is parsed, inside the same try block.
- Immediately after the AI try/catch (so it runs on every path where the AI call succeeded, and is skipped when the catch returns early on AI failure — no usage exists then), inserted an `ai_usage` row wrapped in its own try/catch that swallows all errors silently. Placed *before* the reference-reuse check, so it logs for both the eventual `paid` and `needs_review` decisions.
- `fn: 'verify-payment'`, `order_id`, and the four token fields + `cost_usd`/`cost_php` from `computeCost`.

**`supabase/functions/analyze-shelf/index.ts`:**
- Import: `import { computeCost } from '../_shared/pricing.ts'`
- Hoisted `let usage: Anthropic.Messages.Usage | undefined` outside the try block (alongside `let result`).
- Set `usage = response.usage` after `result` is parsed.
- Inserted the `ai_usage` row **after** the `restock_sessions` insert succeeds (so `session.id` is available), wrapped in its own try/catch.
- `fn: 'analyze-shelf'`, `session_id: session.id`, same token/cost fields.

Both insert blocks use the existing service-role `admin` client already present in each function and never throw — a logging failure cannot break verification or analysis.

## 4. Dashboard card

**File:** `src/pages/admin/Dashboard.tsx`

- Added state: `aiTodayPhp`, `aiTotalPhp`, `aiCount`.
- Added a fetch in the existing `useEffect`: `supabase.from('ai_usage').select('cost_php, created_at')`, computing all-time total, today's total (filtered by `startOfDay`, reusing the existing variable), and total call count.
- Added a card in the 2-column metrics grid (`col-span-2` so it spans both columns under "Sales today" / "Needs review"), using the exact `rounded-lg bg-surface-raised p-5 shadow-card` classes already used by the other cards. Title "AI cost today" with a `Sparkles` lucide-react icon (matching the icon usage pattern already in the file, e.g. `PartyPopper`), big number via `formatPeso(aiTodayPhp)` styled like the "Sales today" number, and a subtitle line: `all-time {formatPeso(aiTotalPhp)} · {aiCount} calls · at ₱58.50 / $1`.

## 5. Deploy output

```
supabase functions deploy verify-payment
→ Uploaded verify-payment/index.ts, _shared/pricing.ts, _shared/verdict.ts
→ {"project_ref":"aztgvfrayjbhtxfvsram","functions":["verify-payment"], ...,"message":"Deployed Functions."}

supabase functions deploy analyze-shelf
→ Uploaded analyze-shelf/index.ts, _shared/pricing.ts
→ {"project_ref":"aztgvfrayjbhtxfvsram","functions":["analyze-shelf"], ...,"message":"Deployed Functions."}
```
(Docker-not-running warning is expected/benign on this machine — deploy still succeeded via the remote bundler.)

## 6. Gate results

- `npm run test`: **16 passed** (13 prior + 3 new pricing tests), 4 test files, no failures.
- `npm run build`: clean — `tsc -b && vite build` succeeded with no type errors, output written to `dist/`.
- `ai_usage` table confirmed present with `count(*) = 0` after migration; both functions redeployed successfully.

## Concerns / notes

- Did not verify the Dashboard card visually in a live browser (Dashboard requires an authenticated admin session + real Supabase data; a stray dev server was already occupying port 5173 outside this session's control). Relied on `tsc -b` type-checking the JSX/state as the verification signal — no type errors.
- No end-to-end test exercised the actual Anthropic API call / real `ai_usage` insert from either Edge Function (would require live Claude API credentials and a real order/session) — coverage is at the pricing-module unit level per the plan's TDD scope.
