-- Lets a customer cancel their own order (or an admin cancel any order) while
-- it is still awaiting payment. The only UPDATE policy on public.orders is
-- "orders admin update", so a plain client-side update would silently match
-- zero rows for a non-admin user; this security definer RPC is required.
create or replace function public.cancel_own_order(p_order_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_user_id uuid;
  v_status text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select user_id, status into v_user_id, v_status
  from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order not found';
  end if;

  if not (v_user_id = auth.uid() or public.is_admin()) then
    raise exception 'forbidden';
  end if;

  -- Only 'awaiting_payment' orders are cancellable: 'verifying' and
  -- 'needs_review' mean the buyer already submitted payment proof and money
  -- may have moved, and 'verifying' races the verify-payment edge function,
  -- which can flip the row to 'paid' underneath us; 'paid' and 'cancelled'
  -- are terminal states.
  if v_status <> 'awaiting_payment' then
    raise exception 'order not cancellable (status %)', v_status;
  end if;

  update public.orders set status = 'cancelled' where id = p_order_id;
end;
$$;

-- No explicit grant: matches the rest of this file's functions
-- (create_order, confirm_order, delete_all_orders, ...), which rely on the
-- default PUBLIC execute grant rather than an explicit "grant execute" line.
