-- Voids an order: reverses its effects and removes it entirely. Used by
-- admins to undo an order (e.g. a mistaken confirmation or a refund),
-- unlike cancel_own_order which only lets a still-unpaid order be marked
-- 'cancelled' without touching stock or deleting anything.
create or replace function public.void_order(p_order_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  r record;
  v_status text;
begin
  if not public.is_admin() then
    raise exception 'forbidden';
  end if;

  select status into v_status from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order not found';
  end if;

  -- confirm_order is the only place stock is ever decremented, and it only
  -- does so on the awaiting_payment/verifying/needs_review -> 'paid'
  -- transition. So a 'paid' order is the only status that ever had stock
  -- deducted, and it's the only one we return stock for here. Don't turn
  -- this into an unconditional stock return for every status: awaiting
  -- orders never touched stock, so "restoring" it for them would inflate
  -- stock above its true level.
  if v_status = 'paid' then
    for r in select item_id, qty from public.order_items where order_id = p_order_id loop
      update public.items set stock = stock + r.qty where id = r.item_id;
    end loop;
  end if;

  -- Detach ai_usage rows instead of deleting them, preserving cost history
  -- (matches delete_all_orders).
  update public.ai_usage set order_id = null where order_id = p_order_id;

  -- order_items cascade via FK, no need to delete them explicitly.
  delete from public.orders where id = p_order_id;
end;
$$;

-- No explicit grant: matches the rest of this file's functions
-- (create_order, confirm_order, delete_all_orders, cancel_own_order, ...),
-- which rely on the default PUBLIC execute grant rather than an explicit
-- "grant execute" line.
