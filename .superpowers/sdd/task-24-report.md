# Task 24: Fix delete_all_orders() missing WHERE clause

## Bug

`public.delete_all_orders()` ran `delete from public.orders;` with no WHERE
clause. The execution context has `sql_safe_updates` on, so this fails at
runtime with "DELETE requires a WHERE clause". The function had never been
executed before, so this only surfaced when the admin first triggered it.

## Fix

New migration: `supabase/migrations/20260703042520_fix_delete_all_orders_where.sql`

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
  update public.ai_usage set order_id = null where order_id is not null;
  delete from public.orders where true;  -- WHERE true satisfies sql_safe_updates; order_items cascade via FK
  return v_count;
end;
$$;
```

Only change from the prior version: `delete from public.orders;` →
`delete from public.orders where true;`. Everything else (security definer,
`is_admin()` guard, count, the `ai_usage` detach update) is unchanged.

## Apply + track steps

1. `supabase migration new fix_delete_all_orders_where` created
   `supabase/migrations/20260703042520_fix_delete_all_orders_where.sql`.
2. Wrote the SQL above into that file.
3. Applied to the linked project:
   `supabase db query --linked --file supabase/migrations/20260703042520_fix_delete_all_orders_where.sql`
   → succeeded, no rows returned (DDL).
4. Checked existing tracked versions before inserting:
   `supabase db query --linked "select version from supabase_migrations.schema_migrations order by version;"`
   → `20260702030220`, `20260703031329`, `20260703035858`.
5. Tracked the new migration to match that format:
   `supabase db query --linked "insert into supabase_migrations.schema_migrations (version) values ('20260703042520');"`
   → succeeded.
6. Re-queried `schema_migrations` to confirm `20260703042520` is now present
   alongside the three prior versions.

## Verification (function replaced, NOT executed)

`supabase db query --linked "select pg_get_functiondef('public.delete_all_orders'::regproc);"`
returned:

```sql
CREATE OR REPLACE FUNCTION public.delete_all_orders()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_count integer;
begin
  if not public.is_admin() then
    raise exception 'forbidden';
  end if;
  select count(*) into v_count from public.orders;
  update public.ai_usage set order_id = null where order_id is not null;
  delete from public.orders where true;  -- WHERE true satisfies sql_safe_updates; order_items cascade via FK
  return v_count;
end;
$function$
```

Confirms the deployed function now contains `delete from public.orders where true;`.

**`select delete_all_orders();` was never run.** Only `pg_get_functiondef`
(read-only introspection) was used to verify the deployed definition. The 3
real orders in the database were not touched. The admin will trigger the
function from the UI.

## Gate

- `npm run build` → clean (tsc -b && vite build succeeded, no errors).
- `npm run test` → 18/18 tests passed (4 test files), no test changes needed.

## Files changed

- Added: `supabase/migrations/20260703042520_fix_delete_all_orders_where.sql`
- Database: `public.delete_all_orders()` function replaced (via `create or
  replace function`) on the linked Supabase project; `supabase_migrations.schema_migrations`
  now includes version `20260703042520`.
