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

  -- confirm_order is the only place stock is ever decremented, and it only
  -- does so on the awaiting_payment/verifying/needs_review -> 'paid'
  -- transition. So a 'paid' order is the only status that ever had stock
  -- deducted, and it's the only one we return stock for here. Don't turn
  -- this into an unconditional stock return for every status: awaiting
  -- orders never touched stock, so "restoring" it for them would inflate
  -- stock above its true level. (Mirrors void_order.)
  --
  -- Aggregate across all paid orders per item first, then apply a single
  -- set-based update: the same item can appear in many different paid
  -- orders (order_items' primary key is (order_id, item_id), not item_id
  -- alone), so summing qty per item_id before updating is what makes this
  -- correct rather than just fast — a plain join without the group by
  -- would apply one join row per order_items row, but the UPDATE would
  -- only take effect once per item (last row wins), silently dropping all
  -- but one order's worth of qty for any item bought in more than one
  -- paid order.
  update public.items i
  set stock = i.stock + agg.qty
  from (
    select oi.item_id, sum(oi.qty) as qty
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    where o.status = 'paid'
    group by oi.item_id
  ) agg
  where i.id = agg.item_id;

  update public.ai_usage set order_id = null where order_id is not null;
  delete from public.orders where true;  -- WHERE true satisfies sql_safe_updates; order_items cascade via FK
  return v_count;
end;
$$;

-- No explicit grant: matches the rest of this file's functions
-- (create_order, confirm_order, void_order, cancel_own_order, ...), which
-- rely on the default PUBLIC execute grant rather than an explicit
-- "grant execute" line.
