# Task 21 — Admin "Delete all transactions"

## Migration

File: `supabase/migrations/20260703035858_delete_all_orders.sql`

```sql
create or replace function public.delete_all_orders()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_count integer;
begin
  if not public.is_admin() then
    raise exception 'forbidden';
  end if;
  select count(*) into v_count from public.orders;
  -- preserve AI cost history: detach it from the orders being removed
  update public.ai_usage set order_id = null where order_id is not null;
  delete from public.orders;  -- order_items cascade via FK on delete cascade
  return v_count;
end;
$$;
```

### Apply / track steps taken
1. `SUPABASE_ACCESS_TOKEN=<redacted> /opt/homebrew/bin/supabase migration new delete_all_orders`
   → created `supabase/migrations/20260703035858_delete_all_orders.sql`.
2. Wrote the SQL above into that file.
3. Checked existing tracked versions: `db query --linked "select version from supabase_migrations.schema_migrations order by version;"` → `20260702030220`, `20260703031329` (bare numeric-string format).
4. Applied: `db query --linked --file supabase/migrations/20260703035858_delete_all_orders.sql` → succeeded, no rows.
5. Tracked: `db query --linked "insert into supabase_migrations.schema_migrations (version, name) values ('20260703035858', 'delete_all_orders');"` → succeeded.
6. Re-checked `schema_migrations` → now contains all three versions including `20260703035858`.

## UI additions (`src/pages/admin/AdminOrders.tsx`)
- New state: `showDeleteAll`, `confirmText`, `deleting`.
- New `deleteAll()` handler: calls `supabase.rpc('delete_all_orders')`, alerts on error, otherwise closes modal, resets `confirmText`, resets to page 0 and reloads via `loadPage(0)`, `deleting` reset in `finally`.
- Header row now has "Orders" title plus a right-aligned `text-sm text-red-600` "Delete all" button that opens the modal.
- Confirmation modal: fixed inset-0 black/40 backdrop (click closes + resets confirmText), centered white rounded panel (click inside stops propagation), title "Delete all transactions?", body copy exactly as specified, "Type DELETE to confirm" label + bound text input, Cancel button and red Delete all button (`disabled={confirmText !== 'DELETE' || deleting}`, label toggles to "Deleting…").
- No changes to pagination/approve/reject logic other than reusing the existing page-0 reload path after a successful delete.

## Verification
- Did **not** execute `delete_all_orders()` at any point — only existence was checked: `select proname from pg_proc where proname='delete_all_orders';` returned the row.
- `npm run test` → 4 test files, 16/16 passed.
- `npm run build` (`tsc -b && vite build`) → clean, no errors.
- Dev server started via preview tooling (auto-assigned port since 5173 was occupied by an unrelated process) purely to confirm the module compiles/serves without runtime errors; console/server logs showed no errors. Route is gated by `RequireAdmin`, so full authenticated visual walkthrough wasn't performed (no admin credentials available) — build/typecheck + clean dev-server compile served as the render check, per task's stated verification bar.
- The 3 real orders in the DB were never touched.
