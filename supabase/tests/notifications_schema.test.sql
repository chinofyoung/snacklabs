create extension if not exists pgtap with schema extensions;
begin;
select plan(24);

select has_table('public', 'notifications', 'notifications table exists');
select has_table('public', 'push_subscriptions', 'push_subscriptions table exists');
select has_function('public', 'notify_user', ARRAY['uuid','text','text','text','text'], 'notify_user exists');
select has_function('public', 'notify_admins', ARRAY['text','text','text','text'], 'notify_admins exists');

-- Neither helper is callable by a client: a signed-in user who could call
-- notify_admins could write arbitrary text into every admin's inbox. Neither is
-- referenced from an RLS policy, so unlike is_active_user() nothing needs
-- authenticated to hold EXECUTE. has_function_privilege resolves PUBLIC and the
-- role's own grant together.
select is(
  (select count(*)::int
   from unnest(array['public.notify_user(uuid,text,text,text,text)',
                     'public.notify_admins(text,text,text,text)']) f
   cross join unnest(array['anon', 'authenticated']) r
   where has_function_privilege(r, f, 'EXECUTE')),
  0, 'neither notify helper is executable by anon or authenticated');

-- The default ACL on the local stack hands anon and authenticated full table
-- rights, so the migration revokes first. A person may read their own
-- notifications and mark them read (UPDATE on the read_at column alone, which
-- table_privs_are does not count as a table-level UPDATE); subscriptions are
-- theirs to manage.
select table_privs_are('public', 'notifications', 'authenticated',
  array['SELECT'], 'authenticated has only table-level SELECT on notifications');
select table_privs_are('public', 'push_subscriptions', 'authenticated',
  array['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  'authenticated can select, insert, update and delete push_subscriptions');

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

-- notify_admins EXCLUDES the acting admin. The role stays as the table owner on
-- purpose: authenticated has no EXECUTE on notify_admins (asserted above), and
-- in production it is only ever reached from a security-definer trigger, which
-- runs as the owner while auth.uid() still reads the caller's JWT claims.
set local request.jwt.claims = '{"sub":"a0000000-0000-0000-0000-000000000001"}';
select is(public.notify_admins('topup_requested','T','B','/admin/topups'), 1,
  'the acting admin is excluded from the fan-out');
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
-- lives_ok alone would also pass if RLS or the column grant made the update
-- match nothing, so check the row really changed.
select is(
  (select count(*)::int from public.notifications where read_at is not null),
  1, 'the notification is now marked read');
-- The column grant is the point: a notification is the record of what the system
-- told someone, so its recipient may not edit the text or the link.
select throws_ok(
  $$update public.notifications set title = 'edited' where user_id = auth.uid()$$,
  '42501', null, 'a user cannot rewrite the title of their own notification');

-- push_subscriptions RLS.
insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
values ('c0000000-0000-0000-0000-000000000003','https://fcm.googleapis.com/fcm/send/abc','k','a');
select is((select count(*)::int from public.push_subscriptions), 1,
  'a user reads only their own push subscriptions');
reset role;
insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
values ('a0000000-0000-0000-0000-000000000001','https://fcm.googleapis.com/fcm/send/zzz','k','a');
set local role authenticated;
set local request.jwt.claims = '{"sub":"c0000000-0000-0000-0000-000000000003"}';
select is((select count(*)::int from public.push_subscriptions), 1,
  'another user''s subscription is not visible');
reset role;

select * from finish();
rollback;
