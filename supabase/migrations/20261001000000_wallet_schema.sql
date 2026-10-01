-- Prepaid customer wallet: a cached balance guarded by a check constraint,
-- plus an append-only ledger. Both are moved together by security-definer
-- functions and triggers (see 20261001000200_wallet_payments.sql); clients
-- never write to these tables directly, which is why only `select` is
-- granted below.

-- ===== wallets =====
create table public.wallets (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  balance numeric(10,2) not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

-- ===== topup_requests (before wallet_entries: FK dependency) =====
create table public.topup_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  -- The 10000 ceiling is a typo guard, not a policy limit: office pantry
  -- top-ups are tens to hundreds of pesos, so a slipped keypress (50000 for
  -- 500) is rejected at entry rather than becoming an awkward conversation
  -- after an admin approves it. Mirrored by TOPUP_MAX in src/lib/wallet.ts.
  amount numeric(10,2) not null check (amount > 0 and amount <= 10000),
  payment_method_id uuid references public.payment_methods(id),
  proof_path text not null,
  status text not null default 'pending'
    check (status in ('pending','approved','rejected')),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  reject_reason text not null default '',
  created_at timestamptz not null default now()
);

-- One pending request per user, enforced in the database rather than only in
-- the UI: two unreviewed proofs make both the admin queue and the customer's
-- own screen ambiguous about which proof belongs to which request.
create unique index topup_requests_one_pending_per_user
  on public.topup_requests (user_id) where status = 'pending';

create index topup_requests_pending_idx
  on public.topup_requests (created_at desc) where status = 'pending';

-- ===== wallet_entries =====
create table public.wallet_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  -- Signed: positive credits, negative debits. Summing this column is the
  -- authoritative history; public.wallets.balance is a cache of it.
  amount numeric(10,2) not null,
  kind text not null check (kind in ('topup','purchase','refund')),
  -- on delete set null, not cascade: void_order DELETES the order row, and
  -- the ledger must survive that. `note` carries a readable reference so
  -- history still reads correctly once order_id is gone.
  order_id uuid references public.orders(id) on delete set null,
  topup_id uuid references public.topup_requests(id) on delete set null,
  note text not null default '',
  created_at timestamptz not null default now()
);

create index wallet_entries_user_created_idx
  on public.wallet_entries (user_id, created_at desc);

-- Makes double-crediting a top-up impossible even if approve_topup is somehow
-- called twice. Deliberately NOT applied to order_id: an order can legitimately
-- be paid, voided and paid again, and each of those is a real journal entry.
create unique index wallet_entries_topup_unique
  on public.wallet_entries (topup_id) where topup_id is not null;

-- ===== RLS =====
alter table public.wallets enable row level security;
alter table public.wallet_entries enable row level security;
alter table public.topup_requests enable row level security;

create policy "wallets read own or admin" on public.wallets for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
create policy "wallet_entries read own or admin" on public.wallet_entries for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
create policy "topup_requests read own or admin" on public.topup_requests for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- No insert/update/delete policies at all: every write goes through a
-- security-definer function, which bypasses RLS by design.

-- ===== Grants =====
-- Explicit, unlike older migrations in this directory, because the default
-- ACL is not something to build on. supabase/config.toml says that with
-- auto_expose_new_tables unset new entities are NOT auto-exposed, and that the
-- field is removed on 2026-10-30. The local stack does not behave that way
-- (see below), and what a hosted project does is not verified here, so this
-- file states the intended privileges outright instead of depending on which
-- default applies. Select only: writes go through functions.
--
-- The revoke comes first because `grant select` alone does not make the
-- privileges select-only: it only adds to whatever the table already has. On
-- the local stack (verified in pg_default_acl), default privileges for tables
-- created by `postgres` in `public` still hand anon, authenticated and
-- service_role full table rights, so without this revoke clients would hold
-- INSERT/UPDATE/DELETE/TRUNCATE on the balance and the ledger, with RLS's
-- missing write policies as the only barrier. Revoking from anon and
-- authenticated makes the resulting privileges the same on every
-- environment, whatever its default ACL says; service_role (RLS-bypassing,
-- used by edge functions) and the owner (so security-definer functions keep
-- working) are left untouched.
revoke all on public.wallets, public.wallet_entries, public.topup_requests
  from anon, authenticated;

grant select on public.wallets to authenticated;
grant select on public.wallet_entries to authenticated;
grant select on public.topup_requests to authenticated;

-- ===== Provisioning =====
-- Three layers, because a credit can never be applied to a missing row:
-- (1) backfill everyone who already exists,
insert into public.wallets (user_id)
select id from public.profiles
on conflict (user_id) do nothing;

-- (2) create one alongside each new profile,
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
  insert into public.wallets (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

-- (3) ensure_wallet, called by the credit/debit paths as belt-and-braces.
create or replace function public.ensure_wallet(p_user_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.wallets (user_id) values (p_user_id)
  on conflict (user_id) do nothing;
end;
$$;

-- pg_default_acl grants EXECUTE on new functions to anon and authenticated
-- directly, the same trap as the tables above, so revoking from PUBLIC alone
-- is not enough. Every caller (approve_topup, sync_order_wallet,
-- release_order_wallet) is itself security definer and runs as postgres, which
-- keeps EXECUTE -- so nothing breaks. Without this, the function is reachable
-- through PostgREST /rpc/ensure_wallet by anyone holding the public anon key,
-- and it is the only definer function here that takes a caller-supplied user
-- id with no auth check.
revoke execute on function public.ensure_wallet(uuid) from public, anon, authenticated;
