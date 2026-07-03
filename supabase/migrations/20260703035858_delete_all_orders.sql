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
