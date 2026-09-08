-- Adds an admin-managed allowlist of specific email addresses that may sign
-- in alongside @goabroad.com accounts, plus a way to revoke access
-- (is_blocked) without deleting the underlying profile or its order history.

-- ===== email_allowlist =====
create table public.email_allowlist (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  note text not null default '',
  created_at timestamptz not null default now()
);

alter table public.email_allowlist enable row level security;

create policy "email_allowlist admin all" on public.email_allowlist for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Case-insensitive uniqueness: without this, "Alice@x.com" and "alice@x.com"
-- would be stored as two separate rows, and a lookup by lower(email) could
-- silently fail to grant access that was actually already allowlisted.
create unique index email_allowlist_email_lower_idx on public.email_allowlist (lower(email));

-- ===== profiles: revocable access =====
alter table public.profiles add column is_blocked boolean not null default false;

-- ===== handle_new_user: allow goabroad.com or allowlisted addresses =====
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.email is null or not (
    new.email ilike '%@goabroad.com'
    or exists (select 1 from public.email_allowlist where lower(email) = lower(new.email))
  ) then
    raise exception 'Only goabroad.com accounts or invited addresses may sign in';
  end if;
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    new.raw_user_meta_data->>'avatar_url'
  );
  return new;
end;
$$;

-- The existing on_auth_user_created trigger (from 20260702030220_init.sql)
-- already points at public.handle_new_user() by function name, so
-- create or replace above is sufficient; the trigger does not need to be
-- dropped or recreated.

-- ===== set_email_access (admin only) =====
create or replace function public.set_email_access(p_email text, p_allowed boolean, p_note text default '')
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_email text;
  v_rows integer;
begin
  if not public.is_admin() then
    raise exception 'forbidden';
  end if;

  v_email := lower(trim(p_email));
  if v_email = '' or v_email not like '%@%' then
    raise exception 'invalid email address';
  end if;

  if p_allowed then
    if not exists (select 1 from public.email_allowlist where lower(email) = v_email) then
      insert into public.email_allowlist (email, note) values (v_email, coalesce(p_note, ''));
    end if;

    update public.profiles set is_blocked = false where lower(email) = v_email;
    get diagnostics v_rows = row_count;

    if v_rows > 0 then
      return 'allowed and unblocked existing account';
    else
      return 'allowed';
    end if;
  else
    -- Block revocation before touching anything: an admin's own account (or
    -- another admin's) must never be locked out via this path.
    if exists (select 1 from public.profiles where lower(email) = v_email and is_admin) then
      raise exception 'cannot revoke access for an admin';
    end if;

    delete from public.email_allowlist where lower(email) = v_email;

    update public.profiles set is_blocked = true where lower(email) = v_email;
    get diagnostics v_rows = row_count;

    if v_rows > 0 then
      return 'removed and blocked existing account';
    else
      return 'removed';
    end if;
  end if;
end;
$$;

-- No explicit grant: matches the rest of this file's functions
-- (create_order, confirm_order, ...), which rely on the default PUBLIC
-- execute grant rather than an explicit "grant execute" line.

-- ===== create_order: reject blocked accounts =====
create or replace function public.create_order(p_items jsonb, p_payment_method_id uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_order_id uuid;
  v_total numeric(10,2) := 0;
  r record;
  v_price numeric(10,2);
  v_stock integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if (select is_blocked from public.profiles where id = auth.uid()) then
    raise exception 'access revoked';
  end if;
  if jsonb_array_length(p_items) = 0 then
    raise exception 'empty order';
  end if;

  insert into public.orders (user_id, total, status, payment_method_id)
  values (auth.uid(), 0, 'awaiting_payment', p_payment_method_id)
  returning id into v_order_id;

  for r in
    select (e->>'item_id')::uuid as item_id, (e->>'qty')::int as qty
    from jsonb_array_elements(p_items) e
  loop
    if r.qty is null or r.qty <= 0 then
      raise exception 'invalid quantity';
    end if;
    select price, stock into v_price, v_stock
    from public.items where id = r.item_id and is_active for update;
    if not found then
      raise exception 'item % not found', r.item_id;
    end if;
    if v_stock < r.qty then
      raise exception 'insufficient stock: %', r.item_id;
    end if;
    insert into public.order_items (order_id, item_id, qty, price_at_purchase)
    values (v_order_id, r.item_id, r.qty, v_price);
    v_total := v_total + v_price * r.qty;
  end loop;

  update public.orders set total = v_total where id = v_order_id;
  return v_order_id;
end;
$$;
