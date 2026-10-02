-- Notifications: a durable record first, delivery second.
--
-- The row is the source of truth. A web push is attempted afterwards and is
-- allowed to fail — dropped by Apple, never permitted, or sent to a home-screen
-- icon that was deleted and re-added. When that happens the notification is
-- still here, unread, and the in-app badge still shows it.

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in (
    'topup_approved', 'topup_rejected', 'topup_requested',
    'registration_pending', 'order_needs_review')),
  title text not null,
  body text not null,
  -- The in-app route to open. Stored rather than derived so the service worker
  -- and the list page cannot disagree about where a notification leads.
  link text not null default '',
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index notifications_user_created_idx
  on public.notifications (user_id, created_at desc);
create index notifications_unread_idx
  on public.notifications (user_id) where read_at is null;

alter table public.notifications enable row level security;

create policy "notifications read own" on public.notifications for select to authenticated
  using (user_id = auth.uid());
-- Update exists ONLY so a person can mark their own notification read. There is
-- deliberately no insert or delete policy: every write comes from a
-- security-definer trigger, matching how wallets and wallet_entries are handled.
create policy "notifications mark own read" on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ===== push_subscriptions =====
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  -- Issued per browser by the push service, and globally unique. It is the
  -- natural key both for replacing a refreshed subscription and for pruning a
  -- dead one when the service answers 404/410.
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text not null default '',
  created_at timestamptz not null default now()
);

create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

create policy "push_subscriptions own" on public.push_subscriptions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ===== notify_user =====
create or replace function public.notify_user(
  p_user_id uuid, p_kind text, p_title text, p_body text, p_link text default ''
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public.notifications (user_id, kind, title, body, link)
  values (p_user_id, p_kind, p_title, p_body, coalesce(p_link, ''))
  returning id into v_id;
  return v_id;
end;
$$;

-- ===== notify_admins =====
-- Fans out one row per admin and skips the actor, so nobody is told about their
-- own click. When the caller is the service role — as it is for
-- order_needs_review, which verify-payment writes — auth.uid() is null, no admin
-- matches the exclusion, and everyone is notified. That is the intended result.
create or replace function public.notify_admins(
  p_kind text, p_title text, p_body text, p_link text default ''
)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_count integer := 0;
  r record;
begin
  for r in
    select id from public.profiles
    where is_admin and (auth.uid() is null or id <> auth.uid())
  loop
    perform public.notify_user(r.id, p_kind, p_title, p_body, p_link);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ===== Grants =====
-- Both helpers exist solely to be called from triggers. Neither is referenced
-- from an RLS policy, so unlike is_active_user() neither needs to be callable by
-- `authenticated` — and a client that could call notify_admins directly could
-- spam every admin with arbitrary text.
revoke execute on function public.notify_user(uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.notify_admins(text, text, text, text) from public, anon, authenticated;

-- The default ACL on a new public table hands anon and authenticated full rights
-- (see the grants note in 20261001000000_wallet_schema.sql), and `grant` only
-- adds to that. So revoke from both first; otherwise authenticated would keep
-- INSERT/DELETE/TRUNCATE on notifications, with the missing write policies as the
-- only barrier. anon needs nothing at all.
revoke all on public.notifications, public.push_subscriptions from anon, authenticated;
grant select on public.notifications to authenticated;
-- UPDATE is granted on read_at alone. The "mark own read" policy lets a person
-- touch their own rows, and this keeps what they may touch to the one column a
-- recipient has any business changing: a notification is the record of what the
-- system told them, so its title, body and link are not theirs to edit.
grant update (read_at) on public.notifications to authenticated;
-- UPDATE is needed as well as INSERT: the client registers a browser with an
-- upsert on endpoint, and INSERT ... ON CONFLICT DO UPDATE requires both. The
-- "own" policy still pins every row to the caller.
grant select, insert, update, delete on public.push_subscriptions to authenticated;
