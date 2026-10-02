create extension if not exists pgtap with schema extensions;
begin;
select plan(42);

select has_function('public', 'is_active_user', 'is_active_user exists');
select has_function('public', 'set_registration_status', ARRAY['uuid','text'], 'set_registration_status exists');
select has_function('public', 'set_user_access', ARRAY['uuid','boolean'], 'set_user_access exists');

-- ===== Who may execute these =====
-- Asserted from the catalog so a regression is caught even where nothing calls
-- them as anon. The last one is the one that matters most: authenticated has to
-- keep EXECUTE on is_active_user(), because every gated policy calls it as the
-- querying role.
select is(
  (select count(*)::int
   from pg_proc p
   cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
   where p.oid = any (array['public.is_active_user()'::regprocedure,
                            'public.set_registration_status(uuid,text)'::regprocedure,
                            'public.set_user_access(uuid,boolean)'::regprocedure])
     and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  0,
  'PUBLIC has no EXECUTE on is_active_user or the two admin RPCs');

select is(
  (select count(*)::int
   from unnest(array['public.is_active_user()',
                     'public.set_registration_status(uuid,text)',
                     'public.set_user_access(uuid,boolean)']) f
   where has_function_privilege('anon', f, 'EXECUTE')),
  0,
  'anon cannot execute is_active_user or the two admin RPCs');

select is(
  (select count(*)::int
   from unnest(array['public.is_active_user()',
                     'public.set_registration_status(uuid,text)',
                     'public.set_user_access(uuid,boolean)']) f
   where not has_function_privilege('authenticated', f, 'EXECUTE')),
  0,
  'authenticated can execute is_active_user and the two admin RPCs');

-- Four users: an admin, a pending registrant, an approved shopper, and an
-- approved shopper whose access has since been revoked.
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'admin@goabroad.com',
   '{"first_name":"Ada","last_name":"Admin"}'::jsonb, now(), now()),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pending@goabroad.com',
   '{"first_name":"Pat","last_name":"Pending"}'::jsonb, now(), now()),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'shopper@goabroad.com',
   '{"first_name":"Sam","last_name":"Shopper"}'::jsonb, now(), now()),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'blocked@goabroad.com',
   '{"first_name":"Bo","last_name":"Blocked"}'::jsonb, now(), now());

update public.profiles set is_admin = true, approval_status = 'approved'
  where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
update public.profiles set approval_status = 'approved'
  where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
update public.profiles set approval_status = 'approved', is_blocked = true
  where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

-- Rows the pending session must not see. The payment method is inserted here
-- rather than relying on the wallet migration's seeded one, so the "reads no
-- payment methods" assertion cannot pass just because the table is empty.
insert into public.items (id, name, price, stock)
values ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'Biscuit', 25, 10);
insert into public.payment_methods (id, label, type, account_name, is_active)
values ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'GCash', 'ewallet', 'Office', true);

-- The pending user owns a wallet (handle_new_user made it), a ledger row and a
-- top-up request, so the "reads none of their own" assertions below are not
-- passing on empty tables.
insert into public.wallet_entries (user_id, amount, kind, note)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 10, 'topup', 'fixture');
insert into public.topup_requests (user_id, amount, proof_path, status)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 100, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/fixture.jpg', 'pending');

-- The approved shopper owns the same two rows, so the matching positive
-- controls below are reading something that is really there.
insert into public.wallet_entries (user_id, amount, kind, note)
values ('cccccccc-cccc-cccc-cccc-cccccccccccc', 10, 'topup', 'fixture');
insert into public.topup_requests (user_id, amount, proof_path, status)
values ('cccccccc-cccc-cccc-cccc-cccccccccccc', 100, 'cccccccc-cccc-cccc-cccc-cccccccccccc/fixture.jpg', 'pending');

-- A domain-list row, so the "non-admin reads none" assertion below is not
-- passing on an empty table and the admin positive control has something to read.
insert into public.allowed_email_domains (domain, note)
values ('approval-gating-fixture.example.com', 'fixture');

-- A QR-code image for the public-bucket listing policy to hide.
insert into storage.objects (bucket_id, name)
values ('qr-codes', 'approval-gating-fixture.jpg');

-- ===== is_active_user =====
set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc"}';
select ok(public.is_active_user(), 'an approved, unblocked user is active');

set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select ok(not public.is_active_user(), 'a pending user is not active');

-- ===== A pending session is inert =====
select is(
  (select count(*)::int from public.items),
  0,
  'a pending user reads no items');

select is(
  (select count(*)::int from public.payment_methods),
  0,
  'a pending user reads no payment methods');

select is(
  (select count(*)::int from public.profiles
   where id <> 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  0,
  'a pending user reads no other profiles');

select is(
  (select count(*)::int from public.profiles
   where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  1,
  'a pending user can still read their own profile');

select is(
  (select count(*)::int from public.wallets
   where user_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  0,
  'a pending user cannot read their own wallet');

select is(
  (select count(*)::int from public.wallet_entries
   where user_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  0,
  'a pending user cannot read their own ledger entries');

select is(
  (select count(*)::int from public.topup_requests
   where user_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  0,
  'a pending user cannot read their own top-up requests');

select is(
  (select count(*)::int from storage.objects where bucket_id = 'qr-codes'),
  0,
  'a pending user cannot list the QR-code bucket');

select throws_ok(
  $$select public.create_order(
      '[{"item_id":"dddddddd-dddd-dddd-dddd-dddddddddddd","qty":1}]'::jsonb, null)$$,
  'P0001',
  'account not approved',
  'a pending user cannot place an order');

-- ===== A pending session cannot write either =====
select throws_ok(
  $$select public.request_topup(100, null, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/p.jpg')$$,
  'P0001',
  'account not approved',
  'a pending user cannot request a top-up');

select throws_ok(
  $$select public.pay_order_with_wallet('00000000-0000-0000-0000-000000000000')$$,
  'P0001',
  'account not approved',
  'a pending user cannot pay from the wallet');

select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('topup-proofs', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/own.jpg')$$,
  '42501', null,
  'a pending user cannot upload a top-up proof into their own folder');

select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner)
    values ('receipts', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/r.jpg',
            'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')$$,
  '42501', null,
  'a pending user cannot upload a receipt');

-- The one write that would undo all the rest: a pending user confirming
-- themselves. profiles has only an admin update policy, so the update matches
-- no rows (it does not raise), which is why the row count is asserted.
with u as (
  update public.profiles set approval_status = 'approved'
  where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  returning 1)
select is(
  (select count(*)::int from u),
  0,
  'a pending user cannot approve themselves');

-- The other refusal reason: an approved account that was later revoked is told
-- so, not that it is still waiting for confirmation.
set local request.jwt.claims = '{"sub":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"}';
select throws_ok(
  $$select public.create_order(
      '[{"item_id":"dddddddd-dddd-dddd-dddd-dddddddddddd","qty":1}]'::jsonb, null)$$,
  'P0001',
  'access revoked',
  'a blocked user cannot place an order, and is told access was revoked');

-- ===== An approved session is unaffected =====
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc"}';
-- Filtered to the fixture row so rows already in a local database cannot
-- change the count.
select is(
  (select count(*)::int from public.items
   where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'),
  1,
  'an approved user reads items');

-- Approval widens the catalogue, not the user list: no screen a shopper can
-- reach reads another user's profile, and every row would expose an email
-- address (and so a domain on the allowlist).
select is(
  (select count(*)::int from public.profiles
   where id <> 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
  0,
  'an approved user reads no other profiles');

-- Positive controls for the gated reads and writes above: the pending
-- assertions would also pass if the policies denied everyone.
select is(
  (select count(*)::int from public.wallets
   where user_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
  1,
  'an approved user reads their own wallet');

select is(
  (select count(*)::int from public.wallet_entries
   where user_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
  1,
  'an approved user reads their own ledger entries');

select is(
  (select count(*)::int from public.topup_requests
   where user_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
  1,
  'an approved user reads their own top-up requests');

select is(
  (select count(*)::int from storage.objects
   where bucket_id = 'qr-codes' and name = 'approval-gating-fixture.jpg'),
  1,
  'an approved user can list the QR-code bucket');

select lives_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('topup-proofs', 'cccccccc-cccc-cccc-cccc-cccccccccccc/own.jpg')$$,
  'an approved user can upload a top-up proof into their own folder');

select lives_ok(
  $$insert into storage.objects (bucket_id, name, owner)
    values ('receipts', 'cccccccc-cccc-cccc-cccc-cccccccccccc/r.jpg',
            'cccccccc-cccc-cccc-cccc-cccccccccccc')$$,
  'an approved user can upload a receipt');

-- ===== Admin-only RPCs =====
select throws_ok(
  $$select public.set_registration_status('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'approved')$$,
  'P0001', 'forbidden', 'a non-admin cannot confirm a registration');

select throws_ok(
  $$select public.set_user_access('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', false)$$,
  'P0001', 'forbidden', 'a non-admin cannot revoke access');

select is(
  (select count(*)::int from public.allowed_email_domains),
  0,
  'a non-admin cannot read the domain list');

set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is(
  public.set_registration_status('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'approved'),
  'approved',
  'an admin confirms a pending registration');

select throws_ok(
  $$select public.set_registration_status('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'bogus')$$,
  'P0001', 'invalid status', 'an unknown status is refused');

select throws_ok(
  $$select public.set_user_access('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false)$$,
  'P0001', 'cannot revoke access for an admin',
  'an admin cannot be blocked');

-- An admin is never stranded behind the rejected screen by another admin (or
-- by themselves). Confirming one stays allowed: that is the way out of
-- 'pending' for a user who was promoted before being approved.
select throws_ok(
  $$select public.set_registration_status('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'rejected')$$,
  'P0001', 'cannot reject an admin',
  'an admin cannot be rejected');

select is(
  public.set_registration_status('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'approved'),
  'approved',
  'an admin registration can still be confirmed');

-- Positive control for the narrowed profiles policy: the "reads no other
-- profiles" assertions above would also pass if it denied everyone, and the
-- admin users page depends on this read.
select is(
  (select count(*)::int from public.profiles
   where id in ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
                'cccccccc-cccc-cccc-cccc-cccccccccccc')),
  3,
  'an admin reads their own and other users'' profiles (admin, pending and approved fixtures)');

-- Positive controls for allowed_email_domains: every other assertion about it
-- is negative, so a policy that denied everyone, admins included, would leave
-- both suites green while /admin/users silently broke.
select is(
  (select count(*)::int from public.allowed_email_domains
   where domain = 'approval-gating-fixture.example.com'),
  1,
  'an admin can read the domain list');

select lives_ok(
  $$insert into public.allowed_email_domains (domain, note)
    values ('approval-gating-admin-insert.example.com', 'admin insert control')$$,
  'an admin can add an allowed domain');

reset role;

select * from finish();
rollback;
