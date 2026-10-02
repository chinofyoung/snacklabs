create extension if not exists pgtap with schema extensions;
begin;
select plan(17);

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

-- The delivery trigger must never be able to roll back the money transaction it
-- observes: a trigger that raises aborts the whole transaction, so a push
-- problem could otherwise stop someone's top-up being credited.
--
-- This block drives the FAILURE path, not the skip path. With no vault secrets
-- configured, dispatch returns early and never reaches the exception handler, so
-- an approval "surviving" would prove nothing. Here the secrets ARE configured,
-- with a URL that makes net.http_post raise, so the handler is the only thing
-- standing between that failure and the approval.
--
-- The fixture is a fresh pending top-up approved through the real approve_topup
-- RPC. Re-approving an already-resolved request would not notify (the trigger
-- requires old.status = 'pending'), so dispatch would never fire at all.
insert into public.topup_requests (id, user_id, amount, proof_path, status)
values ('d0000000-0000-0000-0000-000000000010','c0000000-0000-0000-0000-000000000003', 777, 'a/d.jpg', 'pending');

-- Configured only AFTER the insert above, so that insert still takes the skip
-- path and the single failure under test is the one inside lives_ok.
do $$
begin
  perform vault.create_secret('not a url', 'send_push_url');
  perform vault.create_secret('test-key', 'send_push_key');
end $$;

-- Precondition: this URL really does make net.http_post raise. If a pg_net
-- upgrade ever began accepting it, this fails loudly rather than the
-- assertions below quietly passing without testing anything.
select throws_ok(
  $$select net.http_post(url := 'not a url', body := '{}'::jsonb)$$,
  null, null,
  'the configured push URL makes net.http_post raise');

set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-0000-0000-000000000001"}';
select lives_ok(
  $$select public.approve_topup('d0000000-0000-0000-0000-000000000010')$$,
  'an approval commits even when push dispatch raises');
reset role;

select is(
  (select balance from public.wallets where user_id = 'c0000000-0000-0000-0000-000000000003'),
  777.00::numeric(10,2),
  'the wallet was credited despite the delivery failure');

-- Proves the dispatch trigger really fired: it is an AFTER INSERT trigger on
-- this very row, so the row existing means dispatch ran (and was swallowed).
select is(
  (select count(*)::int from public.notifications
   where kind = 'topup_approved'
     and user_id = 'c0000000-0000-0000-0000-000000000003'
     and body like '%777%'),
  1, 'the approval still notified, so dispatch ran against a row that survived');

select * from finish();
rollback;
