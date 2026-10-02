create extension if not exists pgtap with schema extensions;
begin;
select plan(7);

-- The in-app badge's markAllRead (src/context/NotificationsContext.tsx) sends
--   UPDATE notifications SET read_at = $now WHERE id IN ($ids) AND read_at IS NULL
-- This pins what that write may and may not do, as the signed-in person.

insert into public.allowed_email_domains (domain) values ('example.com') on conflict do nothing;
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values
  ('a0000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','reader-a@example.com','{"first_name":"Ann","last_name":"A"}'::jsonb, now(), now()),
  ('b0000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','reader-b@example.com','{"first_name":"Ben","last_name":"B"}'::jsonb, now(), now());
update public.profiles set approval_status = 'approved'
  where id in ('a0000000-0000-0000-0000-00000000000a','b0000000-0000-0000-0000-00000000000b');

insert into public.notifications (id, user_id, kind, title, body) values
  ('a1000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-00000000000a','topup_approved','A1','x'),
  ('a1000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-00000000000a','topup_approved','A2','x'),
  ('b1000000-0000-0000-0000-000000000001','b0000000-0000-0000-0000-00000000000b','topup_approved','B1','x');
-- A2 was already read from another tab, with an earlier timestamp the client's
-- write must not overwrite.
update public.notifications set read_at = '2026-01-01T00:00:00Z'
  where id = 'a1000000-0000-0000-0000-000000000002';

-- Person A marks all of A's unread rows read, and the id list also happens to
-- name one of B's rows.
set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-0000-0000-00000000000a"}';
select lives_ok(
  $$update public.notifications set read_at = '2026-10-02T00:00:00Z'
    where id in ('a1000000-0000-0000-0000-000000000001',
                 'a1000000-0000-0000-0000-000000000002',
                 'b1000000-0000-0000-0000-000000000001')
      and read_at is null$$,
  'marking read by id list succeeds');
reset role;

select is(
  (select read_at from public.notifications where id = 'a1000000-0000-0000-0000-000000000001'),
  '2026-10-02T00:00:00Z'::timestamptz, 'the unread row named by id is marked read');
select is(
  (select read_at from public.notifications where id = 'a1000000-0000-0000-0000-000000000002'),
  '2026-01-01T00:00:00Z'::timestamptz, 'a row already read keeps its earlier read_at');
select is(
  (select read_at from public.notifications where id = 'b1000000-0000-0000-0000-000000000001'),
  null, 'another person''s row is untouched even when its id is in the list');

-- A write that also carries any other column is refused outright by the column
-- grant, so a client that sent more than read_at would fail visibly.
set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-0000-0000-00000000000a"}';
select throws_ok(
  $$update public.notifications set read_at = now(), title = 'edited'
    where id = 'a1000000-0000-0000-0000-000000000001'$$,
  '42501', null, 'read_at together with another column is refused');
select throws_ok(
  $$update public.notifications set user_id = 'b0000000-0000-0000-0000-00000000000b'
    where id = 'a1000000-0000-0000-0000-000000000001'$$,
  '42501', null, 'a notification cannot be handed to someone else');
reset role;

select is(
  (select title from public.notifications where id = 'a1000000-0000-0000-0000-000000000001'),
  'A1', 'the title is unchanged after the refused write');

select * from finish();
rollback;
