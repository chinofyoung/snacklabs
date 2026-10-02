# Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell a customer when their top-up is approved or rejected, and tell admins when something needs them, durably enough that a dropped push is a delayed notification rather than a lost one.

**Architecture:** Every notification originates from a trigger on the table whose state changed, never from the function or UI that changed it — so it fires for any caller and no existing function body is rewritten. The `notifications` row is the source of truth; a `pg_net` call to a `send-push` Edge Function is a disposable side effect that is allowed to fail. In-app, Supabase Realtime drives an unread badge that needs no permission and works on every browser.

**Tech Stack:** Supabase (Postgres, RLS, triggers, pg_net, Deno Edge Functions, Realtime), Web Push + VAPID, a hand-written service worker, React 19, react-router 8, Tailwind 4, vitest, pgTAP.

**Spec:** `docs/superpowers/specs/2026-10-02-notifications-design.md`

## Global Constraints

- **Never run state-changing git commands.** The repo owner's standing rule. Tasks end with verification, not a commit.
- **Never run a command that touches the LINKED PRODUCTION project** (`aztgvfrayjbhtxfvsram`): no `db push`, `db reset --linked`, `functions deploy`, `config push`, `secrets set`. Local only.
- **Docker IS available**, but its CLI is not on the default PATH. Every supabase command must be prefixed: `export PATH="$HOME/.docker/bin:$PATH"`. Local stack commands (`npx supabase db reset`, `npx supabase test db`) are expected and required.
- **The service worker has NO `fetch` handler.** Adding one turns on offline caching and changes how the whole app loads. It is the single hardest scope boundary in this work.
- **One notification row per recipient.** Admin events fan out; no role column.
- `notify_user` and `notify_admins` are `security definer`, with `execute` revoked from `public` and `anon`, and **not granted to `authenticated`** — unlike `is_active_user()`, neither is referenced from an RLS policy. A client able to call `notify_admins` could spam every admin with arbitrary text.
- VAPID public key is read as `VITE_VAPID_PUBLIC_KEY`. The private key is only ever an Edge Function secret.
- New migrations are additive. Never edit an existing migration.
- `full_name` remains the display field; do not replace its usages.

## Review Focus

Implied by the spec, easy to leave untested. Each has a test assigned to the task that owns it.

1. **A repeated write of the same status must not notify twice** — `verify-payment` can write `needs_review` more than once for one order, and a duplicate "your top-up was approved" about the same money is alarming. *(Task 2)*
2. **A trigger must never roll back the transaction it observes** — a push failure that blocks a top-up approval means a notification bug is holding someone's money. *(Task 3)*
3. **The actor must not be notified about their own action**, including when the actor is the service role and `auth.uid()` is null — in that case every admin *should* be notified. *(Task 1 + Task 2)*
4. **iOS Safari tab must not render a working-looking toggle** — push is unavailable there at any version, so the button would simply fail. *(Task 4 + Task 7)*
5. **A dead subscription must be pruned, and a denied permission must not be re-prompted** — the API cannot re-ask after a denial, so the UI must explain instead of retrying. *(Task 3 + Task 7)*

---

## File Structure

**Create:**
- `supabase/migrations/20261003000000_notifications_schema.sql` — tables, RLS, helpers
- `supabase/migrations/20261003000100_notification_triggers.sql` — the four event triggers
- `supabase/migrations/20261003000200_notification_delivery.sql` — pg_net + the push trigger
- `supabase/tests/notifications_schema.test.sql`
- `supabase/tests/notification_triggers.test.sql`
- `supabase/functions/send-push/index.ts`
- `public/sw.js` — service worker, push + notificationclick only
- `src/lib/push.ts` — capability detection, subscribe/unsubscribe
- `src/lib/push.test.ts`
- `src/context/NotificationsContext.tsx`
- `src/pages/Notifications.tsx`
- `src/components/NotificationBell.tsx`

**Modify:**
- `src/types.ts` — `AppNotification`, `NotificationKind`
- `src/main.tsx` — register the service worker, wrap in `NotificationsProvider`
- `src/App.tsx` — `/notifications` route
- `src/pages/CustomerLayout.tsx` — badge on the bottom nav
- `src/pages/admin/AdminLayout.tsx` — bell in the header
- `src/pages/CustomerSettings.tsx` — the permission toggle
- `src/pages/admin/Settings.tsx` — the permission toggle
- `.env.example` — `VITE_VAPID_PUBLIC_KEY`

---

### Task 1: Schema, RLS and the notify helpers

**Files:**
- Create: `supabase/migrations/20261003000000_notifications_schema.sql`
- Create: `supabase/tests/notifications_schema.test.sql`

**Interfaces:**
- Consumes: `public.profiles` (`id`, `is_admin`), `public.is_admin()`
- Produces:
  - table `public.notifications (id, user_id, kind, title, body, link, read_at, created_at)`
  - table `public.push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at)`
  - `public.notify_user(p_user_id uuid, p_kind text, p_title text, p_body text, p_link text) returns uuid`
  - `public.notify_admins(p_kind text, p_title text, p_body text, p_link text) returns integer`

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/notifications_schema.test.sql`:

```sql
create extension if not exists pgtap with schema extensions;
begin;
select plan(19);

select has_table('public', 'notifications', 'notifications table exists');
select has_table('public', 'push_subscriptions', 'push_subscriptions table exists');
select has_function('public', 'notify_user', ARRAY['uuid','text','text','text','text'], 'notify_user exists');
select has_function('public', 'notify_admins', ARRAY['text','text','text','text'], 'notify_admins exists');

-- Fixtures: one admin, one second admin, one ordinary approved user.
insert into public.allowed_email_domains (domain) values ('example.com') on conflict do nothing;
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values
  ('a0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','admin1@example.com','{"first_name":"Ada","last_name":"One"}'::jsonb, now(), now()),
  ('a0000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','admin2@example.com','{"first_name":"Bo","last_name":"Two"}'::jsonb, now(), now()),
  ('c0000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','shopper@example.com','{"first_name":"Cy","last_name":"Three"}'::jsonb, now(), now());

update public.profiles set is_admin = true, approval_status = 'approved'
  where id in ('a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002');
update public.profiles set approval_status = 'approved'
  where id = 'c0000000-0000-0000-0000-000000000003';

-- notify_user writes exactly one row, to exactly that person.
select lives_ok(
  $$select public.notify_user('c0000000-0000-0000-0000-000000000003','topup_approved','T','B','/wallet')$$,
  'notify_user runs');
select is(
  (select count(*)::int from public.notifications where user_id = 'c0000000-0000-0000-0000-000000000003'),
  1, 'notify_user wrote one row for that user');
select is(
  (select link from public.notifications where user_id = 'c0000000-0000-0000-0000-000000000003'),
  '/wallet', 'link is stored as given');
select is(
  (select read_at from public.notifications where user_id = 'c0000000-0000-0000-0000-000000000003'),
  null, 'a new notification is unread');

-- An unknown kind is refused by the check constraint.
select throws_ok(
  $$select public.notify_user('c0000000-0000-0000-0000-000000000003','not_a_kind','T','B','/')$$,
  '23514', null, 'an unknown kind is rejected');

-- notify_admins with NO actor (service role / null auth.uid()) reaches every admin.
select is(public.notify_admins('order_needs_review','T','B','/admin/orders'), 2,
  'notify_admins with no actor notifies both admins');
select is(
  (select count(*)::int from public.notifications
   where kind = 'order_needs_review' and user_id in
     ('a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002')),
  2, 'one row per admin');
select is(
  (select count(*)::int from public.notifications
   where kind = 'order_needs_review' and user_id = 'c0000000-0000-0000-0000-000000000003'),
  0, 'a non-admin receives no admin notification');

-- notify_admins EXCLUDES the acting admin.
set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-0000-0000-000000000001"}';
select is(public.notify_admins('topup_requested','T','B','/admin/topups'), 1,
  'the acting admin is excluded from the fan-out');
reset role;
select is(
  (select count(*)::int from public.notifications
   where kind = 'topup_requested' and user_id = 'a0000000-0000-0000-0000-000000000001'),
  0, 'the actor did not notify themselves');

-- RLS: a user sees only their own notifications.
set local role authenticated;
set local request.jwt.claims = '{"sub":"c0000000-0000-0000-0000-000000000003"}';
select is((select count(*)::int from public.notifications), 1,
  'a user reads only their own notifications');
select throws_ok(
  $$insert into public.notifications (user_id, kind, title, body)
    values ('a0000000-0000-0000-0000-000000000001','topup_approved','x','y')$$,
  '42501', null, 'a user cannot insert a notification');
select lives_ok(
  $$update public.notifications set read_at = now() where user_id = auth.uid()$$,
  'a user can mark their own notification read');

-- push_subscriptions RLS.
insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
values ('c0000000-0000-0000-0000-000000000003','https://push.example/abc','k','a');
select is((select count(*)::int from public.push_subscriptions), 1,
  'a user reads only their own push subscriptions');
reset role;
insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
values ('a0000000-0000-0000-0000-000000000001','https://push.example/zzz','k','a');
set local role authenticated;
set local request.jwt.claims = '{"sub":"c0000000-0000-0000-0000-000000000003"}';
select is((select count(*)::int from public.push_subscriptions), 1,
  'another user''s subscription is not visible');
reset role;

select * from finish();
rollback;
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
export PATH="$HOME/.docker/bin:$PATH" && cd /Users/chinoyoung/Code/snacklabs && npx supabase test db
```
Expected: FAIL — `relation "public.notifications" does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20261003000000_notifications_schema.sql`:

```sql
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

revoke all on public.notifications from anon;
revoke all on public.push_subscriptions from anon;
grant select, update on public.notifications to authenticated;
grant select, insert, delete on public.push_subscriptions to authenticated;
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
export PATH="$HOME/.docker/bin:$PATH" && cd /Users/chinoyoung/Code/snacklabs && npx supabase db reset && npx supabase test db
```
Expected: PASS — 19/19 in `notifications_schema.test.sql`, and every pre-existing suite still green (285 before this task).

- [ ] **Step 5: Hand off**

Do **not** commit. Report files changed and the suite totals. Suggested command for the owner:

```bash
git add supabase/migrations/20261003000000_notifications_schema.sql supabase/tests/notifications_schema.test.sql && git commit -m "Add a notifications table and the helpers that write to it"
```

---

### Task 2: The four event triggers

**Files:**
- Create: `supabase/migrations/20261003000100_notification_triggers.sql`
- Create: `supabase/tests/notification_triggers.test.sql`

**Interfaces:**
- Consumes: `public.notify_user(uuid, text, text, text, text)`, `public.notify_admins(text, text, text, text)` (Task 1)
- Produces: triggers only; nothing downstream calls them directly

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/notification_triggers.test.sql`:

```sql
create extension if not exists pgtap with schema extensions;
begin;
select plan(13);

insert into public.allowed_email_domains (domain) values ('example.com') on conflict do nothing;

insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values
  ('a0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','admin1@example.com','{"first_name":"Ada","last_name":"One"}'::jsonb, now(), now()),
  ('c0000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','shopper@example.com','{"first_name":"Cy","last_name":"Three"}'::jsonb, now(), now());

update public.profiles set is_admin = true, approval_status = 'approved'
  where id = 'a0000000-0000-0000-0000-000000000001';
update public.profiles set approval_status = 'approved'
  where id = 'c0000000-0000-0000-0000-000000000003';

-- ORDER MATTERS HERE. Both users above were inserted before anyone was an admin,
-- so notify_admins found nobody to tell and wrote nothing. That is correct
-- behaviour, not a missed notification — it is just not what we want to assert.
-- Clear the slate, THEN register someone with an admin already in place.
delete from public.notifications;

insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values ('c0000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','newbie@example.com','{"first_name":"Nia","last_name":"New"}'::jsonb, now(), now());

select is(
  (select count(*)::int from public.notifications
   where kind = 'registration_pending' and user_id = 'a0000000-0000-0000-0000-000000000001'),
  1, 'a new pending registration notified the admin');
select is(
  (select count(*)::int from public.notifications
   where kind = 'registration_pending' and user_id = 'c0000000-0000-0000-0000-000000000009'),
  0, 'the person registering is not notified about themselves');

delete from public.notifications;

-- A new pending top-up notifies admins.
insert into public.topup_requests (id, user_id, amount, proof_path, status)
values ('d0000000-0000-0000-0000-000000000004','c0000000-0000-0000-0000-000000000003', 500, 'a/b.jpg', 'pending');

select is(
  (select count(*)::int from public.notifications
   where kind = 'topup_requested' and user_id = 'a0000000-0000-0000-0000-000000000001'),
  1, 'a new pending top-up notified the admin');
select is(
  (select count(*)::int from public.notifications
   where kind = 'topup_requested' and user_id = 'c0000000-0000-0000-0000-000000000003'),
  0, 'the requester is not notified of their own request');

-- Approval notifies the requester, once.
update public.topup_requests set status = 'approved'
  where id = 'd0000000-0000-0000-0000-000000000004';
select is(
  (select count(*)::int from public.notifications
   where kind = 'topup_approved' and user_id = 'c0000000-0000-0000-0000-000000000003'),
  1, 'approval notified the requester');

-- Writing the same status again must NOT notify twice.
update public.topup_requests set status = 'approved'
  where id = 'd0000000-0000-0000-0000-000000000004';
select is(
  (select count(*)::int from public.notifications
   where kind = 'topup_approved' and user_id = 'c0000000-0000-0000-0000-000000000003'),
  1, 'rewriting the same status does not notify twice');

-- A no-op update touching another column must NOT notify.
update public.topup_requests set reject_reason = 'noop'
  where id = 'd0000000-0000-0000-0000-000000000004';
select is(
  (select count(*)::int from public.notifications
   where kind = 'topup_approved' and user_id = 'c0000000-0000-0000-0000-000000000003'),
  1, 'an unrelated column update does not notify');

-- Rejection notifies the requester.
insert into public.topup_requests (id, user_id, amount, proof_path, status)
values ('d0000000-0000-0000-0000-000000000005','c0000000-0000-0000-0000-000000000003', 250, 'a/c.jpg', 'pending');
update public.topup_requests set status = 'rejected', reject_reason = 'blurry'
  where id = 'd0000000-0000-0000-0000-000000000005';
select is(
  (select count(*)::int from public.notifications
   where kind = 'topup_rejected' and user_id = 'c0000000-0000-0000-0000-000000000003'),
  1, 'rejection notified the requester');

-- The amount appears in the body, so the notification is self-explanatory.
select ok(
  (select body like '%500%' from public.notifications
   where kind = 'topup_approved' and user_id = 'c0000000-0000-0000-0000-000000000003'),
  'the approved amount appears in the notification body');

-- An order entering needs_review notifies admins.
delete from public.notifications;
insert into public.items (id, name, price, stock)
values ('e0000000-0000-0000-0000-000000000006','Biscuit', 25, 10);
insert into public.orders (id, user_id, total, status)
values ('f0000000-0000-0000-0000-000000000007','c0000000-0000-0000-0000-000000000003', 25, 'verifying');

update public.orders set status = 'needs_review'
  where id = 'f0000000-0000-0000-0000-000000000007';
select is(
  (select count(*)::int from public.notifications
   where kind = 'order_needs_review' and user_id = 'a0000000-0000-0000-0000-000000000001'),
  1, 'an order entering needs_review notified the admin');

-- verify-payment can write needs_review more than once for one order.
update public.orders set status = 'needs_review'
  where id = 'f0000000-0000-0000-0000-000000000007';
select is(
  (select count(*)::int from public.notifications
   where kind = 'order_needs_review' and user_id = 'a0000000-0000-0000-0000-000000000001'),
  1, 'a repeated needs_review write does not notify twice');

-- Moving away and back DOES notify again: it is a genuinely new review.
update public.orders set status = 'paid' where id = 'f0000000-0000-0000-0000-000000000007';
update public.orders set status = 'needs_review' where id = 'f0000000-0000-0000-0000-000000000007';
select is(
  (select count(*)::int from public.notifications
   where kind = 'order_needs_review' and user_id = 'a0000000-0000-0000-0000-000000000001'),
  2, 're-entering needs_review notifies again');

-- The customer is never told about the review queue.
select is(
  (select count(*)::int from public.notifications
   where kind = 'order_needs_review' and user_id = 'c0000000-0000-0000-0000-000000000003'),
  0, 'the customer is not notified about the review queue');

select * from finish();
rollback;
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
export PATH="$HOME/.docker/bin:$PATH" && cd /Users/chinoyoung/Code/snacklabs && npx supabase test db
```
Expected: FAIL — counts come back 0 because no triggers exist yet.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20261003000100_notification_triggers.sql`:

```sql
-- Notifications are raised by triggers on the table whose state changed, never
-- by the function or page that changed it.
--
-- Two reasons. First, `needs_review` is not set by an RPC at all —
-- supabase/functions/verify-payment/index.ts writes it directly with the service
-- role — so an RPC-based hook would miss the event admins most need. Second,
-- hooking the others would mean `create or replace` on approve_topup and friends,
-- whose bodies carry wallet row locking and a self-approval guard; retyping them
-- to add one line is how logic gets silently dropped.
--
-- Every trigger is guarded so a repeated or unrelated write cannot notify twice.

-- ===== topup_requests: resolved =====
create or replace function public.tg_notify_topup_resolved()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.status = 'approved' then
    perform public.notify_user(
      new.user_id, 'topup_approved', 'Top-up approved',
      'Your top-up of ' || to_char(new.amount, 'FM999,999,990.00') || ' has been added to your wallet.',
      '/wallet');
  elsif new.status = 'rejected' then
    perform public.notify_user(
      new.user_id, 'topup_rejected', 'Top-up not approved',
      case when coalesce(new.reject_reason, '') = ''
        then 'Your top-up was not approved.'
        else 'Your top-up was not approved: ' || new.reject_reason
      end,
      '/wallet');
  end if;
  return null;
end;
$$;

-- `when` clause rather than an `if` in the body: the guard belongs in the
-- trigger definition so a rewrite of the same status, or an update to an
-- unrelated column, never reaches the function at all.
create trigger notify_topup_resolved
  after update of status on public.topup_requests
  for each row
  when (old.status = 'pending' and new.status in ('approved', 'rejected'))
  execute function public.tg_notify_topup_resolved();

-- ===== topup_requests: requested =====
create or replace function public.tg_notify_topup_requested()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform public.notify_admins(
    'topup_requested', 'Top-up needs review',
    'A top-up of ' || to_char(new.amount, 'FM999,999,990.00') || ' is waiting for approval.',
    '/admin/topups');
  return null;
end;
$$;

create trigger notify_topup_requested
  after insert on public.topup_requests
  for each row
  when (new.status = 'pending')
  execute function public.tg_notify_topup_requested();

-- ===== profiles: registration pending =====
create or replace function public.tg_notify_registration_pending()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform public.notify_admins(
    'registration_pending', 'New registration',
    coalesce(nullif(new.full_name, ''), new.email) || ' is waiting to be confirmed.',
    '/admin/users');
  return null;
end;
$$;

create trigger notify_registration_pending
  after insert on public.profiles
  for each row
  when (new.approval_status = 'pending')
  execute function public.tg_notify_registration_pending();

-- ===== orders: entered needs_review =====
create or replace function public.tg_notify_order_needs_review()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform public.notify_admins(
    'order_needs_review', 'Order needs review',
    'A payment could not be verified automatically and is waiting for you.',
    '/admin/orders');
  return null;
end;
$$;

-- `is distinct from` rather than `<>`: verify-payment can write needs_review more
-- than once for the same order, and an order that leaves and re-enters the queue
-- is a genuinely new review that should notify again.
create trigger notify_order_needs_review
  after update of status on public.orders
  for each row
  when (new.status = 'needs_review' and old.status is distinct from 'needs_review')
  execute function public.tg_notify_order_needs_review();

revoke execute on function public.tg_notify_topup_resolved() from public, anon, authenticated;
revoke execute on function public.tg_notify_topup_requested() from public, anon, authenticated;
revoke execute on function public.tg_notify_registration_pending() from public, anon, authenticated;
revoke execute on function public.tg_notify_order_needs_review() from public, anon, authenticated;
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
export PATH="$HOME/.docker/bin:$PATH" && cd /Users/chinoyoung/Code/snacklabs && npx supabase db reset && npx supabase test db
```
Expected: PASS — 13/13 in `notification_triggers.test.sql`, every other suite still green.

- [ ] **Step 5: Confirm no existing suite was disturbed**

The wallet suites create top-ups and orders, so they now fire these triggers. Confirm none of their `plan(N)` counts changed and all still pass. If a wallet suite fails, the trigger is wrong — do not edit the wallet suite to accommodate it without saying so in your report.

- [ ] **Step 6: Hand off**

Do **not** commit. Suggested command for the owner:

```bash
git add supabase/migrations/20261003000100_notification_triggers.sql supabase/tests/notification_triggers.test.sql && git commit -m "Raise notifications from triggers on the tables that change"
```

---

### Task 3: Push delivery — pg_net trigger and the send-push function

**Files:**
- Create: `supabase/migrations/20261003000200_notification_delivery.sql`
- Create: `supabase/functions/send-push/index.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `public.notifications`, `public.push_subscriptions` (Task 1)
- Produces: `POST /functions/v1/send-push` taking `{ notification_id }`

- [ ] **Step 1: Write the delivery migration**

Create `supabase/migrations/20261003000200_notification_delivery.sql`:

```sql
-- Delivery is a disposable side effect of the notification row.
create extension if not exists pg_net;

create or replace function public.tg_dispatch_push()
returns trigger
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_url text;
  v_key text;
begin
  -- THE EXCEPTION HANDLER IS THE POINT OF THIS FUNCTION.
  --
  -- This trigger runs inside the transaction that approved a top-up. A trigger
  -- that raises rolls that transaction back, which would mean a push-delivery
  -- problem could stop someone's money being credited. Nothing about notifying
  -- people is worth that. Any failure here is swallowed; the notification row is
  -- already committed and the in-app badge will still show it.
  begin
    select decrypted_secret into v_url from vault.decrypted_secrets where name = 'send_push_url';
    select decrypted_secret into v_key from vault.decrypted_secrets where name = 'send_push_key';

    if v_url is null or v_key is null then
      -- Not configured in this environment (local test runs, for instance).
      -- In-app notifications still work; only push is skipped.
      return null;
    end if;

    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_key),
      body := jsonb_build_object('notification_id', new.id)
    );
  exception
    when others then
      raise warning 'push dispatch failed for notification %: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

create trigger dispatch_push
  after insert on public.notifications
  for each row
  execute function public.tg_dispatch_push();

revoke execute on function public.tg_dispatch_push() from public, anon, authenticated;
```

- [ ] **Step 2: Verify the handler actually protects the transaction**

Add to `supabase/tests/notification_triggers.test.sql`, before `finish()`, and raise its `plan()` from 13 to 14:

```sql
-- The delivery trigger must never be able to roll back the money transaction it
-- observes. With no vault secrets configured (as in this test run) dispatch is
-- skipped, and the approval must still commit and still notify.
select lives_ok(
  $$update public.topup_requests set status = 'approved'
    where id = 'd0000000-0000-0000-0000-000000000005'$$,
  'an approval commits even when push dispatch cannot run');
```

Note: `d0000000-...-0005` was rejected earlier in the suite, so this update moves it from `rejected`; the trigger's `when` clause requires `old.status = 'pending'`, so it will not notify. The assertion is about the transaction surviving, not about a notification.

- [ ] **Step 3: Run the suites**

```bash
export PATH="$HOME/.docker/bin:$PATH" && cd /Users/chinoyoung/Code/snacklabs && npx supabase db reset && npx supabase test db
```
Expected: PASS, with `notification_triggers.test.sql` now at 14 (13 plus the rollback assertion).

- [ ] **Step 4: Write the send-push Edge Function**

Create `supabase/functions/send-push/index.ts`:

```ts
import { createClient } from 'npm:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  const { notification_id } = await req.json().catch(() => ({}))
  if (!notification_id) return json({ error: 'notification_id required' }, 400)

  const publicKey = Deno.env.get('VAPID_PUBLIC_KEY')
  const privateKey = Deno.env.get('VAPID_PRIVATE_KEY')
  const subject = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com'
  if (!publicKey || !privateKey) {
    console.error('send-push: VAPID keys are not configured')
    return json({ error: 'not configured' }, 500)
  }
  webpush.setVapidDetails(subject, publicKey, privateKey)

  // Service role: this reads another user's subscriptions on their behalf, which
  // RLS correctly forbids to everyone else.
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )

  const { data: notification, error: nErr } = await admin
    .from('notifications')
    .select('id, user_id, title, body, link')
    .eq('id', notification_id)
    .single()

  if (nErr || !notification) {
    console.error('send-push: notification not found', notification_id, nErr?.message)
    return json({ error: 'not found' }, 404)
  }

  const { data: subs, error: sErr } = await admin
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('user_id', notification.user_id)

  if (sErr) {
    console.error('send-push: could not load subscriptions', sErr.message)
    return json({ error: 'subscription lookup failed' }, 500)
  }
  if (!subs?.length) return json({ ok: true, sent: 0 }, 200)

  const payload = JSON.stringify({
    title: notification.title,
    body: notification.body,
    link: notification.link || '/notifications',
  })

  let sent = 0
  const dead: string[] = []

  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
      )
      sent++
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode
      // 404/410 mean the browser is gone for good — the icon was deleted, the
      // profile wiped, or the subscription expired. Anything else may be
      // transient, so the row is kept.
      if (status === 404 || status === 410) dead.push(s.id)
      else console.error('send-push: send failed', status, (e as Error).message)
    }
  }

  if (dead.length) {
    await admin.from('push_subscriptions').delete().in('id', dead)
  }

  return json({ ok: true, sent, pruned: dead.length }, 200)
})

function json(payload: unknown, status: number) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}
```

- [ ] **Step 5: Record the VAPID public key in the example env**

Append to `.env.example`:

```
# Web Push. Generate a pair with:  npx web-push generate-vapid-keys
# The PUBLIC half belongs here and ships in the client bundle — that is by design.
# The PRIVATE half is a server secret: supabase secrets set VAPID_PRIVATE_KEY=...
VITE_VAPID_PUBLIC_KEY=
```

- [ ] **Step 6: Serve the function and verify it handles a missing notification**

```bash
export PATH="$HOME/.docker/bin:$PATH" && cd /Users/chinoyoung/Code/snacklabs && npx supabase functions serve send-push
```

In a second shell, with the local anon key from `npx supabase status`:

```bash
curl -s -i -X POST http://127.0.0.1:54321/functions/v1/send-push \
  -H "Content-Type: application/json" -H "apikey: <LOCAL_ANON_KEY>" \
  -d '{"notification_id":"00000000-0000-0000-0000-000000000000"}'
```

Expected: `500 {"error":"not configured"}` if no VAPID keys are set locally, or `404 {"error":"not found"}` if they are. Either proves the function runs and fails safely. A crash or a hang is a defect.

- [ ] **Step 7: Hand off**

Do **not** commit, and do **not** deploy — the owner deploys. Suggested command:

```bash
git add supabase/migrations/20261003000200_notification_delivery.sql supabase/functions/send-push/index.ts .env.example && git commit -m "Deliver notifications as web push, without letting delivery block anything"
```

---

### Task 4: Service worker and capability detection

**Files:**
- Create: `public/sw.js`
- Create: `src/lib/push.ts`
- Create: `src/lib/push.test.ts`
- Modify: `src/main.tsx`

**Interfaces:**
- Consumes: `VITE_VAPID_PUBLIC_KEY`
- Produces:
  - `pushSupport(): PushSupport` where `type PushSupport = 'ready' | 'denied' | 'needs-install' | 'unsupported'`
  - `subscribeToPush(): Promise<void>`
  - `unsubscribeFromPush(): Promise<void>`
  - `registerServiceWorker(): void`

- [ ] **Step 1: Write the failing test**

Create `src/lib/push.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { pushSupport } from './push'

const original = {
  userAgent: navigator.userAgent,
}

function setUA(ua: string) {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true })
}

describe('pushSupport', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
  })
  afterEach(() => {
    setUA(original.userAgent)
    vi.unstubAllGlobals()
  })

  it('reports unsupported when PushManager is absent', () => {
    vi.stubGlobal('PushManager', undefined)
    expect(pushSupport()).toBe('unsupported')
  })

  it('reports needs-install on an iPhone that is not standalone', () => {
    // iOS has no web push in a Safari tab at ANY version. A toggle rendered here
    // would simply fail, so the UI must ask for a Home Screen install instead.
    setUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15')
    vi.stubGlobal('PushManager', class {})
    vi.stubGlobal('Notification', { permission: 'default' })
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    expect(pushSupport()).toBe('needs-install')
  })

  it('reports ready on an installed iPhone', () => {
    setUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15')
    vi.stubGlobal('PushManager', class {})
    vi.stubGlobal('Notification', { permission: 'default' })
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    expect(pushSupport()).toBe('ready')
  })

  it('reports denied when permission was refused', () => {
    // The Push API cannot re-prompt after a denial, so the UI must explain
    // rather than offer a button that can never work.
    setUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120')
    vi.stubGlobal('PushManager', class {})
    vi.stubGlobal('Notification', { permission: 'denied' })
    expect(pushSupport()).toBe('denied')
  })

  it('reports ready on desktop Chrome with permission undecided', () => {
    setUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120')
    vi.stubGlobal('PushManager', class {})
    vi.stubGlobal('Notification', { permission: 'default' })
    expect(pushSupport()).toBe('ready')
  })

  it('reports ready when permission is already granted', () => {
    setUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120')
    vi.stubGlobal('PushManager', class {})
    vi.stubGlobal('Notification', { permission: 'granted' })
    expect(pushSupport()).toBe('ready')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/chinoyoung/Code/snacklabs && npm test -- push
```
Expected: FAIL — `Failed to resolve import "./push"`.

- [ ] **Step 3: Write the service worker**

Create `public/sw.js`:

```js
// Service worker for web push ONLY.
//
// There is deliberately NO `fetch` handler here. Adding one turns on offline
// caching, which changes how the entire app loads and is a far larger and
// riskier change than notifications. If you are tempted to add caching, that is
// a separate piece of work with its own design.

self.addEventListener('push', (event) => {
  if (!event.data) return
  let payload
  try {
    payload = event.data.json()
  } catch {
    return
  }
  event.waitUntil(
    self.registration.showNotification(payload.title ?? 'SnackLabs', {
      body: payload.body ?? '',
      icon: '/assets/icon-192.png',
      badge: '/assets/icon-192.png',
      data: { link: payload.link ?? '/notifications' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const link = event.notification.data?.link ?? '/notifications'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      // Focus an open tab if there is one, rather than stacking up new windows.
      for (const w of windows) {
        if ('focus' in w) {
          w.navigate(link)
          return w.focus()
        }
      }
      return self.clients.openWindow(link)
    }),
  )
})
```

- [ ] **Step 4: Write the push helper**

Create `src/lib/push.ts`:

```ts
import { supabase } from './supabase'

export type PushSupport = 'ready' | 'denied' | 'needs-install' | 'unsupported'

function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
}

function isStandalone(): boolean {
  // iOS exposes navigator.standalone; everyone else uses the display-mode query.
  return (
    ('standalone' in navigator && (navigator as { standalone?: boolean }).standalone === true) ||
    (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches)
  )
}

/**
 * What the Settings toggle should render. Deliberately four states rather than a
 * boolean: "you cannot do this here" and "you said no and I cannot ask again"
 * need different words, and offering a button in either case produces a control
 * that silently fails.
 */
export function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported'
  if (!('serviceWorker' in navigator) || typeof PushManager === 'undefined') return 'unsupported'
  if (typeof Notification === 'undefined') return 'unsupported'
  // iOS has no web push in a Safari tab at any version — only from the Home Screen.
  if (isIos() && !isStandalone()) return 'needs-install'
  if (Notification.permission === 'denied') return 'denied'
  return 'ready'
}

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return
  navigator.serviceWorker.register('/sw.js').catch((e) => {
    console.error('service worker registration failed', e)
  })
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)))
}

export async function subscribeToPush(): Promise<void> {
  const key = import.meta.env.VITE_VAPID_PUBLIC_KEY
  if (!key) throw new Error('Push is not configured.')

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('Notification permission was not granted.')

  const registration = await navigator.serviceWorker.ready
  const sub = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key),
  })

  const json = sub.toJSON()
  const { data: userData } = await supabase.auth.getUser()
  const userId = userData.user?.id
  if (!userId) throw new Error('Not signed in.')

  // upsert on endpoint: a browser that re-subscribes gets the same endpoint back,
  // and a stale row for it must not linger alongside the fresh keys.
  const { error } = await supabase.from('push_subscriptions').upsert(
    {
      user_id: userId,
      endpoint: sub.endpoint,
      p256dh: json.keys?.p256dh ?? '',
      auth: json.keys?.auth ?? '',
      user_agent: navigator.userAgent.slice(0, 255),
    },
    { onConflict: 'endpoint' },
  )
  if (error) throw new Error(error.message)
}

export async function unsubscribeFromPush(): Promise<void> {
  const registration = await navigator.serviceWorker.ready
  const sub = await registration.pushManager.getSubscription()
  if (!sub) return
  await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint)
  await sub.unsubscribe()
}

export async function hasPushSubscription(): Promise<boolean> {
  if (pushSupport() !== 'ready') return false
  if (Notification.permission !== 'granted') return false
  const registration = await navigator.serviceWorker.ready
  return (await registration.pushManager.getSubscription()) !== null
}
```

- [ ] **Step 5: Register the worker at startup**

In `src/main.tsx`, add the import and call it once, after the render call:

```tsx
import { registerServiceWorker } from './lib/push'
```

```tsx
registerServiceWorker()
```

- [ ] **Step 6: Run the tests**

```bash
cd /Users/chinoyoung/Code/snacklabs && npm test -- push && npm test && npx tsc -b && npm run lint
```
Expected: 6 new tests pass, the whole suite passes, no type errors, no new lint warnings.

- [ ] **Step 7: Confirm the no-fetch-handler rule holds**

```bash
grep -n "addEventListener" public/sw.js
```
Expected: exactly two matches — `push` and `notificationclick`. A `fetch` listener here is a scope violation, not an improvement.

- [ ] **Step 8: Hand off**

Do **not** commit. Suggested command:

```bash
git add public/sw.js src/lib/push.ts src/lib/push.test.ts src/main.tsx && git commit -m "Add a push-only service worker and capability detection"
```

---

### Task 5: Notifications context and the unread badge

**Files:**
- Modify: `src/types.ts`
- Create: `src/context/NotificationsContext.tsx`
- Create: `src/components/NotificationBell.tsx`
- Modify: `src/main.tsx`
- Modify: `src/pages/CustomerLayout.tsx`
- Modify: `src/pages/admin/AdminLayout.tsx`

**Interfaces:**
- Consumes: `public.notifications` (Task 1), `useAuth()` from `src/context/AuthContext`
- Produces:
  - `type NotificationKind = 'topup_approved' | 'topup_rejected' | 'topup_requested' | 'registration_pending' | 'order_needs_review'`
  - `interface AppNotification { id, user_id, kind, title, body, link, read_at, created_at }`
  - `useNotifications(): { items: AppNotification[]; unread: number; markAllRead: () => Promise<void>; reload: () => Promise<void> }`
  - `<NotificationBell />`

- [ ] **Step 1: Add the types**

Append to `src/types.ts`:

```ts
export type NotificationKind =
  | 'topup_approved' | 'topup_rejected' | 'topup_requested'
  | 'registration_pending' | 'order_needs_review'

export interface AppNotification {
  id: string
  user_id: string
  kind: NotificationKind
  title: string
  body: string
  link: string
  read_at: string | null
  created_at: string
}
```

- [ ] **Step 2: Write the context**

Create `src/context/NotificationsContext.tsx`:

```tsx
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from './AuthContext'
import type { AppNotification } from '../types'

interface NotificationsState {
  items: AppNotification[]
  unread: number
  markAllRead: () => Promise<void>
  reload: () => Promise<void>
}

const NotificationsContext = createContext<NotificationsState>({
  items: [], unread: 0, markAllRead: async () => {}, reload: async () => {},
})

const PAGE = 50

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth()
  const [items, setItems] = useState<AppNotification[]>([])

  const reload = useCallback(async () => {
    if (!session) { setItems([]); return }
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(PAGE)
    if (error) return // leave the last known list rather than blanking the badge
    setItems((data as AppNotification[]) ?? [])
  }, [session])

  useEffect(() => { void reload() }, [reload])

  // Realtime is the half that needs no permission, no service worker and no
  // particular OS version — it is why a dropped push is a delayed notification
  // rather than a lost one.
  useEffect(() => {
    if (!session) return
    const channel = supabase
      .channel('notifications')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${session.user.id}` },
        (payload) => setItems((prev) => [payload.new as AppNotification, ...prev].slice(0, PAGE)),
      )
      // A dropped socket must not leave a permanently stale badge.
      .subscribe((status) => { if (status === 'SUBSCRIBED') void reload() })
    return () => { void supabase.removeChannel(channel) }
  }, [session, reload])

  const markAllRead = useCallback(async () => {
    const now = new Date().toISOString()
    const unreadIds = items.filter((n) => !n.read_at).map((n) => n.id)
    if (!unreadIds.length) return
    setItems((prev) => prev.map((n) => (n.read_at ? n : { ...n, read_at: now })))
    const { error } = await supabase.from('notifications').update({ read_at: now }).in('id', unreadIds)
    if (error) void reload() // put the badge back if the write did not land
  }, [items, reload])

  const unread = items.filter((n) => !n.read_at).length

  return (
    <NotificationsContext.Provider value={{ items, unread, markAllRead, reload }}>
      {children}
    </NotificationsContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useNotifications() {
  return useContext(NotificationsContext)
}
```

- [ ] **Step 3: Write the bell**

Create `src/components/NotificationBell.tsx`:

```tsx
import { Link } from 'react-router'
import { Bell } from 'lucide-react'
import { useNotifications } from '../context/NotificationsContext'

export default function NotificationBell({ className = '' }: { className?: string }) {
  const { unread } = useNotifications()
  return (
    <Link
      to="/notifications"
      className={`relative inline-flex items-center justify-center rounded-md p-2 ${className}`}
      aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
    >
      <Bell className="size-5" strokeWidth={2.5} aria-hidden="true" />
      {unread > 0 && (
        <span className="absolute top-0.5 right-0.5 min-w-4 h-4 px-1 rounded-full bg-brand-600 text-white text-[10px] font-bold flex items-center justify-center tabular-nums">
          {unread > 9 ? '9+' : unread}
        </span>
      )}
    </Link>
  )
}
```

- [ ] **Step 4: Wrap the app in the provider**

In `src/main.tsx`, import `NotificationsProvider` and nest it **inside** `AuthProvider` — it reads `useAuth()`:

```tsx
import { NotificationsProvider } from './context/NotificationsContext'
```

The provider tree becomes `AuthProvider > NotificationsProvider > (existing children)`.

- [ ] **Step 5: Add the badge to both layouts**

In `src/pages/admin/AdminLayout.tsx`, the header at roughly line 58 is `flex justify-end` and holds the "Visit store" link. Add the bell beside it:

```tsx
import NotificationBell from '../../components/NotificationBell'
```

```tsx
<NotificationBell />
```

In `src/pages/CustomerLayout.tsx`, add a fifth entry to the `NAV` array so notifications are reachable on mobile:

```tsx
import { Bell, LayoutDashboard, ReceiptText, Settings, Store, Wallet } from 'lucide-react'
```

```tsx
const NAV: NavItem[] = [
  { to: '/store', label: 'Store', icon: Store, end: false },
  { to: '/orders', label: 'My orders', icon: ReceiptText, end: false },
  { to: '/wallet', label: 'Top up', icon: Wallet, end: false },
  { to: '/notifications', label: 'Alerts', icon: Bell, end: false },
  { to: '/settings', label: 'Settings', icon: Settings, end: false },
]
```

Then render the count on that one tab. Add the hook at the top of `CustomerLayout`:

```tsx
import { useNotifications } from '../context/NotificationsContext'
```

```tsx
  const { unread } = useNotifications()
```

and replace the icon line inside the `NAV.map` with a wrapper that can carry a badge:

```tsx
              <span className="relative">
                <n.icon className="size-6" strokeWidth={2.5} aria-hidden="true" />
                {n.to === '/notifications' && unread > 0 && (
                  <span className="absolute -top-1 -right-1.5 min-w-4 h-4 px-1 rounded-full bg-brand-600 text-white text-[10px] font-bold flex items-center justify-center tabular-nums">
                    {unread > 9 ? '9+' : unread}
                  </span>
                )}
              </span>
```

Give the Alerts `NavLink` an accessible name that includes the count, so the badge is not visual-only:

```tsx
              aria-label={n.to === '/notifications' && unread > 0 ? `${n.label}, ${unread} unread` : undefined}
```

Keep the existing `min-w-11` touch target. Five items at 44px fit within 375px, but check at 320px (iPhone SE) and report the measured result rather than assuming.

- [ ] **Step 6: Verify**

```bash
cd /Users/chinoyoung/Code/snacklabs && npx tsc -b && npm test && npm run lint && npm run build
```
Expected: clean typecheck, all tests pass, no new lint warnings, build succeeds.

- [ ] **Step 7: Hand off**

Do **not** commit. Suggested command:

```bash
git add src/types.ts src/context/NotificationsContext.tsx src/components/NotificationBell.tsx src/main.tsx src/pages/CustomerLayout.tsx src/pages/admin/AdminLayout.tsx && git commit -m "Show an unread notification badge, updated live"
```

---

### Task 6: The notifications page

**Files:**
- Create: `src/pages/Notifications.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `useNotifications()` (Task 5)
- Produces: route `/notifications`

- [ ] **Step 1: Write the page**

Create `src/pages/Notifications.tsx`:

```tsx
import { useEffect } from 'react'
import { Link } from 'react-router'
import { Bell } from 'lucide-react'
import { useNotifications } from '../context/NotificationsContext'

export default function Notifications() {
  const { items, unread, markAllRead } = useNotifications()

  // Seeing the list IS reading it. Marking on mount rather than behind a button
  // keeps the badge honest: it should mean "things you have not looked at".
  useEffect(() => {
    if (unread > 0) void markAllRead()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="p-4 md:p-8 space-y-4 max-w-md mx-auto w-full app-frame">
      <h1 className="font-display text-xl font-bold">Alerts</h1>

      {items.length === 0 ? (
        <div className="text-center py-12 space-y-2">
          <Bell className="size-12 mx-auto text-ink-500" strokeWidth={2.5} aria-hidden="true" />
          <p className="text-ink-700 font-medium">Nothing yet</p>
          <p className="text-ink-500 text-sm">
            You'll hear from us when a top-up is reviewed.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((n) => (
            <li key={n.id}>
              <Link
                to={n.link || '/notifications'}
                className={`block rounded-lg p-3 shadow-card ${n.read_at ? 'bg-surface-raised' : 'bg-brand-50'}`}
              >
                <p className="font-medium text-sm flex items-center gap-2">
                  {!n.read_at && <span className="size-2 rounded-full bg-brand-600 shrink-0" aria-hidden="true" />}
                  {n.title}
                </p>
                <p className="text-sm text-ink-700 mt-0.5">{n.body}</p>
                <p className="text-xs text-ink-500 mt-1">
                  <time dateTime={n.created_at}>{new Date(n.created_at).toLocaleString()}</time>
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Add the route**

In `src/App.tsx`, import the page and add it inside the `RequireAuth`/`CustomerLayout` group so it inherits the shell and the guard:

```tsx
import Notifications from './pages/Notifications'
```

```tsx
<Route path="/notifications" element={<Notifications />} />
```

Note: admins reach it through the bell in their own header; the route living in the customer group is fine because `RequireAuth` admits admins too.

- [ ] **Step 3: Verify**

```bash
cd /Users/chinoyoung/Code/snacklabs && npx tsc -b && npm test && npm run lint && npm run build
```
Expected: all clean.

- [ ] **Step 4: Hand off**

Do **not** commit. Suggested command:

```bash
git add src/pages/Notifications.tsx src/App.tsx && git commit -m "Add the alerts page"
```

---

### Task 7: The permission toggle

**Files:**
- Modify: `src/pages/CustomerSettings.tsx`
- Modify: `src/pages/admin/Settings.tsx`
- Create: `src/components/PushToggle.tsx`

**Interfaces:**
- Consumes: `pushSupport()`, `subscribeToPush()`, `unsubscribeFromPush()`, `hasPushSubscription()` (Task 4)
- Produces: `<PushToggle />`

- [ ] **Step 1: Write the toggle**

Create `src/components/PushToggle.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { BellRing } from 'lucide-react'
import { pushSupport, subscribeToPush, unsubscribeFromPush, hasPushSubscription, type PushSupport } from '../lib/push'

export default function PushToggle() {
  const [support, setSupport] = useState<PushSupport>('unsupported')
  const [on, setOn] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setSupport(pushSupport())
    void hasPushSubscription().then(setOn)
  }, [])

  const toggle = async () => {
    setBusy(true)
    setError(null)
    try {
      if (on) {
        await unsubscribeFromPush()
        setOn(false)
      } else {
        // The permission prompt must come from this click. iOS requires a user
        // gesture, and asking on page load is how people end up denying forever.
        await subscribeToPush()
        setOn(true)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change notification settings.')
      setSupport(pushSupport()) // a fresh denial changes which state we are in
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-2xl bg-surface-raised shadow-sm p-4 md:p-5 space-y-3">
      <h2 className="font-display text-lg font-bold flex items-center gap-1.5">
        <BellRing className="size-5 text-brand-600" strokeWidth={2.5} aria-hidden="true" />
        Notifications
      </h2>

      {support === 'needs-install' && (
        <p className="text-sm text-ink-500">
          Add SnackLabs to your Home Screen to turn on notifications. Tap the share button,
          then <b>Add to Home Screen</b>, and open it from there.
        </p>
      )}

      {support === 'denied' && (
        <p className="text-sm text-ink-500">
          Notifications are blocked for this site. You'll need to allow them in your browser
          settings — we can't ask again from here.
        </p>
      )}

      {support === 'unsupported' && (
        <p className="text-sm text-ink-500">
          This browser doesn't support notifications. You'll still see alerts in the app.
        </p>
      )}

      {support === 'ready' && (
        <>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-ink-700">
              {on ? 'On for this device.' : 'Get told when a top-up is reviewed, even when the app is closed.'}
            </p>
            <button
              role="switch"
              aria-checked={on}
              aria-label="Push notifications"
              disabled={busy}
              onClick={toggle}
              className={`shrink-0 w-12 h-7 rounded-full transition relative disabled:opacity-50 ${on ? 'bg-brand-600' : 'bg-ink-900/15'}`}
            >
              <span className={`absolute top-0.5 size-6 rounded-full bg-white shadow transition ${on ? 'left-[calc(100%-1.625rem)]' : 'left-0.5'}`} />
            </button>
          </div>
          <p className="text-xs text-ink-500">Each device needs turning on separately.</p>
        </>
      )}

      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
    </section>
  )
}
```

- [ ] **Step 2: Mount it on both settings pages**

In `src/pages/CustomerSettings.tsx`, import and render `<PushToggle />` below the existing heading, matching the page's existing section spacing.

In `src/pages/admin/Settings.tsx`, import and render `<PushToggle />` as a section alongside the existing "AI payment verification" and payment-methods sections.

- [ ] **Step 3: Verify**

```bash
cd /Users/chinoyoung/Code/snacklabs && npx tsc -b && npm test && npm run lint && npm run build
```
Expected: all clean.

- [ ] **Step 4: Verify the four states render correctly**

With `npm run dev` running, open Settings and confirm:
1. Desktop Chrome shows the toggle (state `ready`).
2. With notifications blocked for localhost in browser settings, it shows the "blocked" explanation and **no toggle**.
3. Using device emulation with an iPhone user agent, it shows the "Add to Home Screen" message and **no toggle**.

Report what you actually observed in each case. A rendered toggle in cases 2 or 3 is a defect — those are the states where a button cannot work.

- [ ] **Step 5: Full verification**

```bash
export PATH="$HOME/.docker/bin:$PATH" && cd /Users/chinoyoung/Code/snacklabs && npx tsc -b && npm test && npm run lint && npm run build && npx supabase test db
```
Expected: everything green, including all pgTAP suites.

- [ ] **Step 6: Hand off**

Do **not** commit. Suggested command:

```bash
git add src/components/PushToggle.tsx src/pages/CustomerSettings.tsx src/pages/admin/Settings.tsx && git commit -m "Let people turn on push notifications per device"
```
