-- Replaces the hardcoded @goabroad.com rule and the per-address
-- email_allowlist with an admin-managed list of allowed email DOMAINS, and
-- makes every new account start pending until an admin confirms it.
--
-- The domain list is a secret: users are never told which domains are
-- allowed, so this table is admin-only for READ as well as write, and the
-- eligibility check runs in a security-definer function rather than
-- anywhere the browser can reach.

-- ===== allowed_email_domains =====
create table public.allowed_email_domains (
  id uuid primary key default gen_random_uuid(),
  domain text not null,
  note text not null default '',
  created_at timestamptz not null default now()
);

alter table public.allowed_email_domains enable row level security;

create policy "allowed_email_domains admin all" on public.allowed_email_domains
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Case-insensitive uniqueness: "GoAbroad.com" and "goabroad.com" are the same
-- domain, and two rows would make removal look like it had failed.
create unique index allowed_email_domains_domain_lower_idx
  on public.allowed_email_domains (lower(domain));

-- Seed: goabroad.com was hardcoded in handle_new_user, and adelanteabroad.com
-- is the domain of the single row that existed in email_allowlist. Seeding
-- both means no one who can sign in today loses access.
insert into public.allowed_email_domains (domain, note) values
  ('goabroad.com', 'Primary company domain'),
  ('adelanteabroad.com', 'Partner domain')
on conflict do nothing;

-- ===== is_email_domain_allowed =====
-- Mirrors src/lib/emailDomain.ts. Returns the FULL domain comparison, so
-- a@mail.goabroad.com does NOT match a goabroad.com entry: one listing must
-- never authorise every subdomain beneath it.
create or replace function public.is_email_domain_allowed(p_email text)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare
  v_email text;
  v_domain text;
begin
  if p_email is null then
    return false;
  end if;

  v_email := lower(trim(p_email));

  -- Exactly one @, with something on each side.
  if array_length(string_to_array(v_email, '@'), 1) <> 2 then
    return false;
  end if;

  v_domain := split_part(v_email, '@', 2);
  if split_part(v_email, '@', 1) = '' or v_domain = '' or v_domain not like '%.%' then
    return false;
  end if;

  return exists (
    select 1 from public.allowed_email_domains where lower(domain) = v_domain
  );
end;
$$;

-- The domain list is a secret, and this function answers questions about it.
-- With the default PUBLIC execute grant PostgREST exposes it as an RPC to the
-- anon key, so anyone could probe candidate domains and enumerate the list.
-- Only the register Edge Function (service_role) may ask. The handle_new_user
-- trigger is unaffected: it is security definer, so its internal call runs as
-- the definer regardless of these grants.
revoke execute on function public.is_email_domain_allowed(text) from public, anon, authenticated;
grant execute on function public.is_email_domain_allowed(text) to service_role;

-- ===== profiles: names and approval =====
alter table public.profiles
  add column first_name text not null default '',
  add column last_name  text not null default '',
  add column approved_by uuid references public.profiles(id) on delete set null,
  add column approved_at timestamptz;

-- Two steps, and the order matters. Adding the column with default 'approved'
-- backfills every EXISTING row as approved, so no current user is locked out.
-- Only then does the default flip to 'pending' for accounts created from here on.
alter table public.profiles
  add column approval_status text not null default 'approved'
    check (approval_status in ('pending', 'approved', 'rejected'));

alter table public.profiles
  alter column approval_status set default 'pending';

create index profiles_approval_status_idx on public.profiles (approval_status)
  where approval_status = 'pending';

-- ===== handle_new_user =====
-- Serves two sign-up paths with different metadata shapes:
--   email/password (via the register Edge Function) sends first_name/last_name
--   Google OAuth sends full_name/avatar_url and no split name
-- full_name stays the single display field the rest of the app reads. A name
-- is NOT split on whitespace for OAuth users: names do not reliably divide
-- that way, and a wrong split is worse than an empty field.
--
-- This re-checks the domain even though the Edge Function already did:
-- supabase.auth.signUp() remains reachable with the public anon key, and
-- Google OAuth never passes through the function at all.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_first text := coalesce(new.raw_user_meta_data->>'first_name', '');
  v_last  text := coalesce(new.raw_user_meta_data->>'last_name', '');
  v_full  text;
begin
  if not public.is_email_domain_allowed(new.email) then
    raise exception 'This email address is not eligible to register';
  end if;

  v_full := nullif(trim(v_first || ' ' || v_last), '');
  if v_full is null then
    v_full := coalesce(new.raw_user_meta_data->>'full_name', '');
  end if;

  insert into public.profiles (id, email, first_name, last_name, full_name, avatar_url)
  values (new.id, new.email, v_first, v_last, v_full,
          new.raw_user_meta_data->>'avatar_url');

  insert into public.wallets (user_id) values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

-- ===== Teardown of the per-address allowlist =====
-- set_email_access was also the only way to set is_blocked; that capability
-- moves to set_user_access in 20261002000100_approval_gating.sql.
drop function if exists public.set_email_access(text, boolean, text);

-- NOT dropped: this table is the only record of which individual addresses were
-- granted access, and the domain seed above assumes it held just the one
-- adelanteabroad.com row. If it held others, those people lose access when this
-- migration runs, and their addresses are the only way to find out who they were.
-- Renaming preserves that evidence and is reversible; the owner can drop the
-- archive once they have reconciled it against the domain list.
alter table if exists public.email_allowlist rename to email_allowlist_archived_20261002;

-- ===== Grants =====
-- The default ACL on a new table hands anon and authenticated broad rights (see
-- the grants note in 20261001000000_wallet_schema.sql). RLS already denies every
-- row here, but RLS is one mistake away from being the only thing standing between
-- a user and the secret this whole feature protects. Revoke first, then grant back
-- only what the admin UI needs; anon needs nothing at all.
revoke all on public.allowed_email_domains from anon, authenticated;
grant select, insert, update, delete on public.allowed_email_domains to authenticated;
