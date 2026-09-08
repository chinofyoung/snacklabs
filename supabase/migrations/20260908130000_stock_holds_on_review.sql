-- Makes stock-holding follow order status, not just the 'paid' event: an
-- order now deducts stock the moment it reaches a stock-holding status
-- ('needs_review' or 'paid'), and returns it the moment it leaves one
-- (rejected/cancelled, or deleted). Previously stock was only deducted by
-- confirm_order() on the transition to 'paid', so an order sitting in
-- 'needs_review' -- e.g. a receipt an admin hasn't reviewed yet, or one the
-- AI verifier parked for manual review -- held no stock at all, letting a
-- second customer buy the same item out from under it.
--
-- This is centralised in triggers on public.orders rather than taught to
-- every call site, because two of the three places that change an order's
-- status are plain table updates, not RPCs, and can't be made to "remember"
-- to move stock:
--   - supabase/functions/verify-payment/index.ts sets status = 'needs_review'
--     via a plain `.from('orders').update(...)` using the service-role client.
--   - src/pages/admin/AdminOrders.tsx's reject() sets status = 'cancelled'
--     via a plain `.from('orders').update(...)`.
-- Putting the accounting in an AFTER UPDATE trigger makes both of those
-- correct automatically, with no redeploy and no UI change. confirm_order,
-- void_order and delete_all_orders are simplified below to match: they stop
-- doing their own stock math and rely on the trigger.

-- ===== sync_order_stock: deduct/return stock on any status change =====
create or replace function public.sync_order_stock()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  r record;
  v_old_holds boolean;
  v_new_holds boolean;
begin
  if old.status is distinct from new.status then
    v_old_holds := old.status in ('needs_review', 'paid');
    v_new_holds := new.status in ('needs_review', 'paid');

    if not v_old_holds and v_new_holds then
      -- Entering a stock-holding status (e.g. verifying -> needs_review, or
      -- awaiting_payment/verifying -> paid): deduct. The guarded UPDATE +
      -- not-found check gives a friendly, specific error instead of relying
      -- on items.stock's `check (stock >= 0)`, whose violation message
      -- doesn't say which item ran out. Raising here aborts the whole
      -- transaction, which rolls back the status change too -- that's
      -- intentional: an order must never sit in a stock-holding status
      -- without the stock actually having been taken.
      for r in select item_id, qty from public.order_items where order_id = new.id loop
        update public.items set stock = stock - r.qty
        where id = r.item_id and stock >= r.qty;
        if not found then
          raise exception 'insufficient stock for item %', r.item_id;
        end if;
      end loop;
    elsif v_old_holds and not v_new_holds then
      -- Leaving a stock-holding status (admin reject, or paid -> cancelled
      -- via void semantics elsewhere): return.
      for r in select item_id, qty from public.order_items where order_id = new.id loop
        update public.items set stock = stock + r.qty where id = r.item_id;
      end loop;
    end if;
    -- else: both old and new status hold stock (needs_review -> paid) or
    -- neither does (awaiting_payment -> verifying, awaiting_payment ->
    -- cancelled) -- no stock movement either way. This branch is what stops
    -- needs_review -> paid from deducting a second time.
  end if;

  return new;
end;
$$;

drop trigger if exists sync_order_stock on public.orders;
create trigger sync_order_stock
  after update on public.orders
  for each row execute function public.sync_order_stock();

-- ===== release_order_stock: return stock if a holding order is deleted =====
create or replace function public.release_order_stock()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  r record;
begin
  if old.status in ('needs_review', 'paid') then
    for r in select item_id, qty from public.order_items where order_id = old.id loop
      update public.items set stock = stock + r.qty where id = r.item_id;
    end loop;
  end if;
  return old;
end;
$$;

drop trigger if exists release_order_stock on public.orders;
create trigger release_order_stock
  before delete on public.orders
  for each row execute function public.release_order_stock();

-- ===== One-time backfill: reconcile pre-existing 'needs_review' orders =====
-- Everything above this point is correct going forward, but it does nothing
-- for orders that already exist at the moment this migration runs. This
-- block reconciles those, once, so the new model's invariant -- "an order
-- holds stock if and only if its status is 'needs_review' or 'paid'" --
-- is true immediately, not just for orders created from now on.
--
-- Why only 'needs_review' and not 'paid': under the OLD model, confirm_order
-- deducted stock only on the awaiting_payment/verifying/needs_review ->
-- 'paid' transition. So every order already sitting in 'paid' has already
-- had its stock deducted -- exactly what the new model expects -- and needs
-- no adjustment. 'awaiting_payment', 'verifying' and 'cancelled' orders held
-- no stock under either model and are likewise left untouched.
--
-- 'needs_review' is the one mismatch: under the old model it held no stock
-- (confirm_order only deducted on -> 'paid'), but the new model treats it as
-- stock-holding. Left unreconciled, that gap breaks in both directions the
-- next time an admin acts on one of these orders:
--   - reject/cancel it -> sync_order_stock takes the "leaving a holding
--     status" branch and RETURNS stock that was never taken -> inventory
--     silently inflates.
--   - approve it (needs_review -> paid) -> both statuses hold stock, so
--     sync_order_stock's "no movement either way" branch applies -> stock is
--     NEVER taken -> the exact oversell this feature exists to prevent.
--
-- This must run exactly once, as part of this migration, and must not be
-- reintroduced later. It aggregates qty per item_id across ALL needs_review
-- orders before updating -- the same trap already documented in
-- 20260904190000_delete_all_orders_return_stock.sql: order_items' primary
-- key is (order_id, item_id), not item_id alone, so the same item can appear
-- in several needs_review orders at once. A plain join without the group by
-- would still only apply once per item (an UPDATE affects each target row
-- once no matter how many join partners match it), silently dropping all
-- but one order's worth of qty for any item bought in more than one
-- needs_review order.
--
-- items.stock has `check (stock >= 0)`. If an item was already oversold
-- under the old model -- precisely the scenario this feature exists to
-- prevent going forward -- a naive `stock - qty` could go negative and trip
-- that constraint, aborting this entire migration and failing the deploy.
-- So this clamps at 0 with greatest(...) instead of failing, and reports via
-- RAISE NOTICE how many items were clamped (i.e. where needs_review demand
-- exceeded current stock) so whoever runs the migration sees the accuracy
-- loss immediately instead of discovering a wrong stock count later.
--
-- Trigger safety: this updates public.items directly and never assigns to
-- orders.status, so sync_order_stock (an AFTER UPDATE trigger on
-- public.orders) has no update on public.orders to fire on, and cannot be
-- invoked by this block.
--
-- Placement: this runs after sync_order_stock/release_order_stock exist
-- (so the new invariant they enforce going forward is what this backfill is
-- restoring for existing rows) but before confirm_order/void_order/
-- delete_all_orders are redefined below. That ordering is arbitrary with
-- respect to correctness -- this block only ever touches public.items, so
-- it has no dependency on those functions' old or new bodies -- but it
-- reads better here: first the new accounting model is installed, then
-- existing data is brought into line with it, then the call sites that used
-- to do their own stock math are simplified to rely on it.
do $$
declare
  v_clamped_count integer;
begin
  select count(*) into v_clamped_count
  from (
    select oi.item_id, sum(oi.qty) as qty
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    where o.status = 'needs_review'
    group by oi.item_id
  ) agg
  join public.items i on i.id = agg.item_id
  where agg.qty > i.stock;

  if v_clamped_count > 0 then
    raise notice
      'stock_holds_on_review backfill: % item(s) had needs_review demand exceeding current stock; stock clamped to 0 instead of going negative',
      v_clamped_count;
  end if;

  update public.items i
  set stock = greatest(i.stock - agg.qty, 0)
  from (
    select oi.item_id, sum(oi.qty) as qty
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    where o.status = 'needs_review'
    group by oi.item_id
  ) agg
  where i.id = agg.item_id;
end;
$$ language plpgsql;

-- ===== confirm_order: no longer deducts stock itself =====
-- The sync_order_stock trigger now deducts on the transition into 'paid'
-- (when the order didn't already hold stock) via the UPDATE below, and
-- correctly deducts nothing when the order was already 'needs_review'
-- (it already holds stock). Leaving the old deduction loop in place here
-- would double-deduct for needs_review -> paid orders, so it is removed
-- entirely rather than guarded -- there is now exactly one place stock
-- accounting happens.
create or replace function public.confirm_order(p_order_id uuid, p_verdict jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_status text;
begin
  if not (public.is_admin() or auth.role() = 'service_role') then
    raise exception 'forbidden';
  end if;

  select status into v_status from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order not found';
  end if;
  if v_status not in ('awaiting_payment', 'verifying', 'needs_review') then
    raise exception 'order not confirmable (status %)', v_status;
  end if;

  update public.orders
  set status = 'paid', ai_verdict = coalesce(p_verdict, ai_verdict)
  where id = p_order_id;
end;
$$;

-- ===== void_order: no longer returns stock itself =====
-- The release_order_stock before-delete trigger now returns stock for any
-- order whose status holds stock ('needs_review' or 'paid') at the moment
-- of deletion -- which also fixes a gap in the previous version: it only
-- ever returned stock for 'paid' orders, so voiding a 'needs_review' order
-- silently lost its held stock forever.
create or replace function public.void_order(p_order_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_status text;
begin
  if not public.is_admin() then
    raise exception 'forbidden';
  end if;

  select status into v_status from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order not found';
  end if;

  -- Detach ai_usage rows instead of deleting them, preserving cost history
  -- (matches delete_all_orders).
  update public.ai_usage set order_id = null where order_id = p_order_id;

  -- order_items cascade via FK, no need to delete them explicitly. Stock is
  -- returned (if this order held any) by the release_order_stock trigger.
  delete from public.orders where id = p_order_id;
end;
$$;

-- ===== delete_all_orders: no longer returns stock itself =====
-- The release_order_stock before-delete trigger now returns stock per row
-- as each order is deleted below, in place of the previous single
-- aggregated UPDATE (which also only covered 'paid' orders, missing
-- 'needs_review'). Firing one trigger per deleted order is slower than one
-- set-based UPDATE, but at this app's scale (an admin bulk-clearing
-- office-pantry orders) that's immaterial next to having exactly one code
-- path -- the trigger -- decide whether an order holds stock. Correctness
-- and centralisation win over raw speed here.
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
  delete from public.orders where true;  -- WHERE true satisfies sql_safe_updates; order_items cascade via FK, release_order_stock trigger returns stock per row
  return v_count;
end;
$$;

-- ===== cancel_own_order: unchanged =====
-- Not redefined here. It only permits awaiting_payment -> cancelled
-- (supabase/migrations/20260904170000_cancel_own_order.sql), and neither
-- status holds stock, so sync_order_stock correctly does nothing for it.

-- No explicit grant: matches the rest of this file's functions
-- (create_order, confirm_order, void_order, delete_all_orders,
-- cancel_own_order, ...), which rely on the default PUBLIC execute grant
-- rather than an explicit "grant execute" line.
