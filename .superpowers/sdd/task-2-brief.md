### Task 2: Database schema, RLS, functions, storage buckets

**Files:**
- Create: `supabase/migrations/00001_init.sql` (run `supabase init` first if `supabase/` doesn't exist)

**Interfaces:**
- Produces (used by all later tasks):
  - Tables: `profiles`, `items`, `payment_methods`, `orders`, `order_items`, `restock_sessions` (columns below).
  - `public.is_admin() returns boolean`
  - `public.create_order(p_items jsonb, p_payment_method_id uuid) returns uuid` — `p_items` is `[{"item_id": "<uuid>", "qty": <int>}]`; validates stock, snapshots prices, returns the new order id with status `awaiting_payment`.
  - `public.confirm_order(p_order_id uuid, p_verdict jsonb) returns void` — decrements stock + sets `paid`; callable only by service role or admins.
  - `public.apply_restock(p_session_id uuid, p_lines jsonb) returns void` — `p_lines` is `[{"item_id": "<uuid>"|null, "name": str, "price": num, "qty": int, "category": str}]`; admin only.
  - Storage buckets: `item-images` (public), `qr-codes` (public), `receipts` (private), `restock-photos` (private).

- [ ] **Step 1: Init supabase dir and create the migration**

```bash
supabase init   # skip if supabase/config.toml exists
supabase migration new init
```

Write the generated file (rename content target: `supabase/migrations/*_init.sql`) with exactly:

```sql
-- ===== Tables =====
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text not null default '',
  avatar_url text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  price numeric(10,2) not null check (price >= 0),
  stock integer not null default 0 check (stock >= 0),
  image_url text,
  category text not null default 'snacks',
  low_stock_threshold integer not null default 3,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.payment_methods (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  type text not null check (type in ('ewallet','bank')),
  qr_image_url text not null,
  account_name text not null,
  account_number text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  total numeric(10,2) not null default 0,
  status text not null default 'awaiting_payment'
    check (status in ('awaiting_payment','verifying','paid','needs_review','cancelled')),
  payment_method_id uuid references public.payment_methods(id),
  receipt_image_url text,
  ai_verdict jsonb,
  created_at timestamptz not null default now()
);

create table public.order_items (
  order_id uuid not null references public.orders(id) on delete cascade,
  item_id uuid not null references public.items(id),
  qty integer not null check (qty > 0),
  price_at_purchase numeric(10,2) not null,
  primary key (order_id, item_id)
);

create table public.restock_sessions (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references public.profiles(id),
  photo_url text not null,
  ai_result jsonb,
  status text not null default 'pending_review'
    check (status in ('pending_review','applied','discarded')),
  created_at timestamptz not null default now()
);

-- ===== Auth: profile creation + domain restriction =====
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.email is null or new.email not ilike '%@goabroad.com' then
    raise exception 'Only goabroad.com accounts may sign in';
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

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ===== Helper =====
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false)
$$;

-- ===== RLS =====
alter table public.profiles enable row level security;
alter table public.items enable row level security;
alter table public.payment_methods enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.restock_sessions enable row level security;

create policy "profiles read all" on public.profiles for select to authenticated using (true);
create policy "profiles admin update" on public.profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "items read" on public.items for select to authenticated using (true);
create policy "items admin write" on public.items for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "pm read" on public.payment_methods for select to authenticated using (true);
create policy "pm admin write" on public.payment_methods for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "orders read own or admin" on public.orders for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
create policy "orders admin update" on public.orders for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
-- inserts happen only via create_order() (security definer); no insert policy needed.

create policy "order_items read" on public.order_items for select to authenticated
  using (exists (
    select 1 from public.orders o
    where o.id = order_id and (o.user_id = auth.uid() or public.is_admin())
  ));

create policy "restock admin all" on public.restock_sessions for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ===== create_order =====
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

-- ===== confirm_order (service role / admin only) =====
create or replace function public.confirm_order(p_order_id uuid, p_verdict jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  r record;
  v_status text;
begin
  if not (public.is_admin() or auth.role() = 'service_role') then
    raise exception 'forbidden';
  end if;

  select status into v_status from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order not found';
  end if;
  if v_status not in ('awaiting_payment','verifying','needs_review') then
    raise exception 'order not confirmable (status %)', v_status;
  end if;

  for r in select item_id, qty from public.order_items where order_id = p_order_id loop
    update public.items set stock = stock - r.qty
    where id = r.item_id and stock >= r.qty;
    if not found then
      raise exception 'insufficient stock at confirmation';
    end if;
  end loop;

  update public.orders
  set status = 'paid', ai_verdict = coalesce(p_verdict, ai_verdict)
  where id = p_order_id;
end;
$$;

-- ===== apply_restock (admin only) =====
create or replace function public.apply_restock(p_session_id uuid, p_lines jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  r record;
begin
  if not public.is_admin() then
    raise exception 'forbidden';
  end if;

  for r in
    select
      nullif(e->>'item_id','')::uuid as item_id,
      e->>'name' as name,
      (e->>'price')::numeric(10,2) as price,
      (e->>'qty')::int as qty,
      coalesce(e->>'category','snacks') as category
    from jsonb_array_elements(p_lines) e
  loop
    if r.qty is null or r.qty <= 0 then continue; end if;
    if r.item_id is not null then
      update public.items set stock = stock + r.qty where id = r.item_id;
    else
      insert into public.items (name, price, stock, category)
      values (r.name, coalesce(r.price, 0), r.qty, r.category);
    end if;
  end loop;

  update public.restock_sessions set status = 'applied' where id = p_session_id;
end;
$$;

-- ===== Storage buckets =====
insert into storage.buckets (id, name, public) values
  ('item-images','item-images', true),
  ('qr-codes','qr-codes', true),
  ('receipts','receipts', false),
  ('restock-photos','restock-photos', false);

create policy "public buckets read" on storage.objects for select to authenticated
  using (bucket_id in ('item-images','qr-codes'));
create policy "admin write public buckets" on storage.objects for insert to authenticated
  with check (bucket_id in ('item-images','qr-codes') and public.is_admin());
create policy "admin update public buckets" on storage.objects for update to authenticated
  using (bucket_id in ('item-images','qr-codes') and public.is_admin());
create policy "admin delete public buckets" on storage.objects for delete to authenticated
  using (bucket_id in ('item-images','qr-codes') and public.is_admin());

create policy "receipts upload own" on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and owner = auth.uid());
create policy "receipts reupload own" on storage.objects for update to authenticated
  using (bucket_id = 'receipts' and owner = auth.uid())
  with check (bucket_id = 'receipts' and owner = auth.uid());
create policy "receipts read own or admin" on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and (owner = auth.uid() or public.is_admin()));

create policy "restock photos admin" on storage.objects for insert to authenticated
  with check (bucket_id = 'restock-photos' and public.is_admin());
create policy "restock photos admin read" on storage.objects for select to authenticated
  using (bucket_id = 'restock-photos' and public.is_admin());
```

- [ ] **Step 2: Apply the migration**

Run: `supabase db push`
Expected: migration applies cleanly. If the project isn't linked, STOP and ask the user to run `supabase link --project-ref <ref>` (or ask them to paste the SQL into the Dashboard SQL editor and confirm).

- [ ] **Step 3: Verify schema**

Run: `supabase db diff` (expected: no drift) or, via SQL editor:

```sql
select count(*) from public.items;                          -- 0, no error
select public.is_admin();                                    -- false (no auth), no error
select id, public from storage.buckets order by id;          -- 4 rows
```

- [ ] **Step 4: Remind the user (do not skip)**

Tell the user: after their first Google sign-in (Task 3 verification), run in the SQL editor:
`update public.profiles set is_admin = true where email = 'chino.young@goabroad.com';`

---

