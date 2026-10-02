create extension if not exists pgtap with schema extensions;
begin;
select plan(70);

-- Alice is the customer, Admin the reviewer, Bob a second customer used for
-- cross-customer isolation checks, and Second Admin the reviewer of Admin's own
-- requests (an admin cannot approve their own top-up). @goabroad.com is required by handle_new_user.
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values ('11111111-1111-1111-1111-111111111111',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'alice@goabroad.com', '{"full_name":"Alice"}'::jsonb, now(), now()),
       ('22222222-2222-2222-2222-222222222222',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'admin@goabroad.com', '{"full_name":"Admin"}'::jsonb, now(), now()),
       ('33333333-3333-3333-3333-333333333333',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'bob@goabroad.com', '{"full_name":"Bob"}'::jsonb, now(), now()),
       ('44444444-4444-4444-4444-444444444444',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'admin2@goabroad.com', '{"full_name":"Second Admin"}'::jsonb, now(), now());
update public.profiles set is_admin = true
where id in ('22222222-2222-2222-2222-222222222222',
             '44444444-4444-4444-4444-444444444444');
-- A new profile starts pending, and request_topup, the topup_requests read
-- policy and the topup-proofs upload policy all require an approved account.
-- Alice and Bob are shoppers. Admin also files top-ups of their own (as a
-- shopper, not as a reviewer), so is approved too. Second Admin only reviews,
-- and the review RPCs check is_admin() alone, so needs no approval.
update public.profiles set approval_status = 'approved'
where id in ('11111111-1111-1111-1111-111111111111',
             '22222222-2222-2222-2222-222222222222',
             '33333333-3333-3333-3333-333333333333');

-- One payment method a customer may pay by, and one that has been switched off.
insert into public.payment_methods (id, label, type, account_name, is_active)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'GCash', 'ewallet', 'Office', true),
       ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Old bank', 'bank', 'Office', false);

-- ===== Bucket =====
select is(
  (select public from storage.buckets where id = 'topup-proofs'),
  false,
  'topup-proofs bucket exists and is private');

-- Enforced by the Storage API at upload time, so the most this can pin down is
-- that the bucket is configured with them.
select is(
  (select file_size_limit from storage.buckets where id = 'topup-proofs'),
  5242880::bigint,
  'topup-proofs caps uploads at 5 MiB, matching the client guard');

select is(
  (select allowed_mime_types from storage.buckets where id = 'topup-proofs'),
  array['image/jpeg'],
  'topup-proofs only accepts image/jpeg, which is what the client uploads');

-- ===== Who may execute the RPCs =====
-- Supabase's default privileges hand EXECUTE on every new public function to
-- PUBLIC and to anon/authenticated/service_role, so "only signed-in users may
-- call this" has to be made true, not assumed. Asserted from the catalog so a
-- regression is caught even where no one thinks to call it as anon.
select is(
  (select count(*)::int
   from pg_proc p
   cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
   where p.oid = any (array['public.request_topup(numeric,uuid,text)'::regprocedure,
                            'public.approve_topup(uuid)'::regprocedure,
                            'public.reject_topup(uuid,text)'::regprocedure])
     and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  0,
  'PUBLIC has no EXECUTE on any top-up RPC');

select is(
  (select count(*)::int
   from unnest(array['public.request_topup(numeric,uuid,text)',
                     'public.approve_topup(uuid)',
                     'public.reject_topup(uuid,text)']) f
   where has_function_privilege('anon', f, 'EXECUTE')),
  0,
  'anon cannot execute any top-up RPC');

select is(
  (select count(*)::int
   from unnest(array['public.request_topup(numeric,uuid,text)',
                     'public.approve_topup(uuid)',
                     'public.reject_topup(uuid,text)']) f
   where not has_function_privilege('authenticated', f, 'EXECUTE')),
  0,
  'authenticated can execute every top-up RPC');

-- ===== request_topup: input validation (as Alice) =====
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111"}';

select throws_ok(
  $$select public.request_topup(0, null, '11111111-1111-1111-1111-111111111111/p.jpg')$$,
  'P0001', 'amount must be above 0 and at most 10000',
  'a zero amount is rejected');
select throws_ok(
  $$select public.request_topup(-5, null, '11111111-1111-1111-1111-111111111111/p.jpg')$$,
  'P0001', 'amount must be above 0 and at most 10000',
  'a negative amount is rejected');
select throws_ok(
  $$select public.request_topup(10001, null, '11111111-1111-1111-1111-111111111111/p.jpg')$$,
  'P0001', 'amount must be above 0 and at most 10000',
  'an amount above the cap is rejected');
select throws_ok(
  $$select public.request_topup(0.004, null, '11111111-1111-1111-1111-111111111111/p.jpg')$$,
  'P0001', 'amount can have at most two decimal places',
  'a sub-centavo amount is rejected rather than silently rounded');
-- The case that motivated the rule: numeric(10,2) would store this as 100.00,
-- so without the check a customer's 100.004 is silently credited as 100.
select throws_ok(
  $$select public.request_topup(100.004, null, '11111111-1111-1111-1111-111111111111/p.jpg')$$,
  'P0001', 'amount can have at most two decimal places',
  'an amount that would silently round down is rejected');

-- Proof path: exactly `<own uid>/<file>`.
select throws_ok(
  $$select public.request_topup(100, null, '33333333-3333-3333-3333-333333333333/p.jpg')$$,
  'P0001', 'proof path must be in your own folder',
  'a proof in another customer''s folder is rejected');
select throws_ok(
  $$select public.request_topup(100, null, '11111111-1111-1111-1111-111111111111')$$,
  'P0001', 'proof path must be in your own folder',
  'a proof path with no file name is rejected');
select throws_ok(
  $$select public.request_topup(100, null, null)$$,
  'P0001', 'proof path must be in your own folder',
  'a missing proof path is rejected');
select throws_ok(
  $$select public.request_topup(100, null,
      '11111111-1111-1111-1111-111111111111/../33333333-3333-3333-3333-333333333333/p.jpg')$$,
  'P0001', 'proof path must be in your own folder',
  'a proof path that climbs out of the folder with .. is rejected');
select throws_ok(
  $$select public.request_topup(100, null, '11111111-1111-1111-1111-111111111111/..')$$,
  'P0001', 'proof path must be in your own folder',
  'a proof path whose file name is .. is rejected');
select throws_ok(
  $$select public.request_topup(100, null, '11111111-1111-1111-1111-111111111111/ ')$$,
  'P0001', 'proof path must be in your own folder',
  'a proof path with a blank file name is rejected');
select throws_ok(
  $$select public.request_topup(100, null, '11111111-1111-1111-1111-111111111111/a/')$$,
  'P0001', 'proof path must be in your own folder',
  'a proof path with a trailing folder and no file is rejected');
select throws_ok(
  $$select public.request_topup(100, null, '11111111-1111-1111-1111-111111111111/a/b.jpg')$$,
  'P0001', 'proof path must be in your own folder',
  'a proof path nested a level too deep is rejected');

-- Payment method: enforced by the server, not just by the client's filter.
select throws_ok(
  $$select public.request_topup(100, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      '11111111-1111-1111-1111-111111111111/m.jpg')$$,
  'P0001', 'that payment method is not available for top-ups',
  'an inactive payment method is rejected');
select throws_ok(
  $$select public.request_topup(100, 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      '11111111-1111-1111-1111-111111111111/m.jpg')$$,
  'P0001', 'that payment method is not available for top-ups',
  'an unknown payment method gets the friendly message, not a foreign-key error');
-- Relies on Task 3 (20261001000200_wallet_payments.sql) having widened the
-- type constraint and seeded the wallet method; if that row is ever absent the
-- id is null, the request succeeds, and this assertion fails loudly.
select throws_ok(
  $$select public.request_topup(100,
      (select id from public.payment_methods where type = 'wallet'),
      '11111111-1111-1111-1111-111111111111/m.jpg')$$,
  'P0001', 'that payment method is not available for top-ups',
  'the wallet payment method cannot be used to top up the wallet');

-- ===== request_topup: happy path and the one-pending rule =====
select lives_ok(
  $$select public.request_topup(500, null, '11111111-1111-1111-1111-111111111111/p.jpg')$$,
  'customer can request a top-up');

select throws_ok(
  $$select public.request_topup(50, null, '11111111-1111-1111-1111-111111111111/r.jpg')$$,
  'P0001', 'you already have a top-up waiting for approval',
  'a second pending request gets the friendly message, not a constraint error');

-- A customer must not be able to approve or reject their own request
select throws_ok(
  $$select public.approve_topup(
      (select id from public.topup_requests limit 1))$$,
  'forbidden',
  'customer cannot approve their own top-up');
select throws_ok(
  $$select public.reject_topup(
      (select id from public.topup_requests limit 1), 'nope')$$,
  'forbidden',
  'customer cannot reject their own top-up');

-- ===== anon is refused at the function boundary =====
-- Claims are cleared, not left as Alice's, so a pass here cannot be a
-- side effect of a stale identity.
reset role;
set local role anon;
set local request.jwt.claims = '';
select throws_ok(
  $$select public.request_topup(100, null, '11111111-1111-1111-1111-111111111111/z.jpg')$$,
  '42501', null,
  'anon is refused permission to request a top-up');
select throws_ok(
  $$select public.approve_topup('00000000-0000-0000-0000-000000000000')$$,
  '42501', null,
  'anon is refused permission to approve a top-up');

-- ===== approve_topup (as Admin) =====
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222"}';

select lives_ok(
  $$select public.approve_topup((select id from public.topup_requests limit 1))$$,
  'admin can approve');

select is(
  (select balance from public.wallets where user_id = '11111111-1111-1111-1111-111111111111'),
  500::numeric(10,2),
  'approval credits the balance');

select is(
  (select count(*)::int from public.wallet_entries e
   where e.user_id = '11111111-1111-1111-1111-111111111111'
     and e.kind = 'topup' and e.amount = 500
     and e.topup_id = (select id from public.topup_requests
                       where user_id = '11111111-1111-1111-1111-111111111111')),
  1,
  'approval writes exactly one topup ledger entry linked to the request');

select ok(
  (select status = 'approved'
          and reviewed_by = '22222222-2222-2222-2222-222222222222'
          and reviewed_at is not null
   from public.topup_requests where user_id = '11111111-1111-1111-1111-111111111111'),
  'approval stamps status, reviewer and time');

-- Approving twice must not double-credit
select throws_ok(
  $$select public.approve_topup((select id from public.topup_requests limit 1))$$,
  'P0001', 'top-up already approved',
  'approving an already-approved request is rejected');

select is(
  (select balance from public.wallets where user_id = '11111111-1111-1111-1111-111111111111'),
  500::numeric(10,2),
  'the rejected second approval left the balance alone');

select throws_ok(
  $$select public.approve_topup('00000000-0000-0000-0000-000000000000')$$,
  'P0001', 'top-up request not found',
  'approving an unknown request id is rejected');

-- ===== reject_topup =====
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111"}';
select lives_ok(
  $$select public.request_topup(200, null, '11111111-1111-1111-1111-111111111111/q.jpg')$$,
  'customer can request again once the previous request is resolved');

set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222"}';
select lives_ok(
  $$select public.reject_topup(
      (select id from public.topup_requests where status = 'pending'), 'Proof unreadable')$$,
  'admin can reject');

select is(
  (select reject_reason from public.topup_requests where status = 'rejected'),
  'Proof unreadable',
  'rejection stores the reason');

select ok(
  (select reviewed_by = '22222222-2222-2222-2222-222222222222'
          and reviewed_at is not null
   from public.topup_requests where status = 'rejected'),
  'rejection stamps reviewer and time');

-- Rejection writes no ledger entry
select is(
  (select count(*)::int from public.wallet_entries
   where user_id = '11111111-1111-1111-1111-111111111111'),
  1,
  'rejection writes no ledger entry');

select is(
  (select balance from public.wallets where user_id = '11111111-1111-1111-1111-111111111111'),
  500::numeric(10,2),
  'rejection leaves the balance alone');

select throws_ok(
  $$select public.reject_topup((select id from public.topup_requests where status = 'rejected'), 'again')$$,
  'P0001', 'top-up already rejected',
  'rejecting an already-rejected request is rejected');

-- A fractional amount paid by an active method round-trips exactly, and a
-- blank reason falls back to a readable default.
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111"}';
select lives_ok(
  $$select public.request_topup(99.50, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      '11111111-1111-1111-1111-111111111111/s.jpg')$$,
  'customer can request a fractional amount with an active payment method');

select is(
  (select amount::text || ' via ' || payment_method_id::text
   from public.topup_requests where status = 'pending'),
  '99.50 via aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'the fractional amount and payment method are stored exactly');

set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222"}';
select lives_ok(
  $$select public.reject_topup((select id from public.topup_requests where status = 'pending'), '   ')$$,
  'admin can reject with a blank reason');

select is(
  (select reject_reason from public.topup_requests where amount = 99.50),
  'No reason given',
  'a blank rejection reason falls back to a default');

-- Approving a fractional amount credits exactly that, to the centavo.
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111"}';
select lives_ok(
  $$select public.request_topup(12.34, null, '11111111-1111-1111-1111-111111111111/t.jpg')$$,
  'customer can request an amount with two significant decimals');

set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222"}';
select lives_ok(
  $$select public.approve_topup((select id from public.topup_requests where status = 'pending'))$$,
  'admin can approve a fractional amount');

select is(
  (select balance from public.wallets where user_id = '11111111-1111-1111-1111-111111111111'),
  512.34::numeric(10,2),
  'a fractional approval credits exactly to the centavo');

-- ===== An admin cannot approve their own top-up =====
-- Both halves matter. The refusal alone would also pass if approve_topup raised
-- for everyone; the second admin succeeding on the very same request is what
-- shows the guard is scoped to "yourself" rather than to "any admin".
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222"}';
select lives_ok(
  $$select public.request_topup(300, null, '22222222-2222-2222-2222-222222222222/a.jpg')$$,
  'an admin can request a top-up for themselves');

select throws_ok(
  $$select public.approve_topup(
      (select id from public.topup_requests
       where user_id = '22222222-2222-2222-2222-222222222222' and status = 'pending'))$$,
  'P0001', 'you cannot approve your own top-up',
  'an admin cannot approve their own top-up');

select is(
  (select balance from public.wallets where user_id = '22222222-2222-2222-2222-222222222222'),
  0::numeric(10,2),
  'the refused self-approval credited nothing');

set local request.jwt.claims = '{"sub":"44444444-4444-4444-4444-444444444444"}';
select lives_ok(
  $$select public.approve_topup(
      (select id from public.topup_requests
       where user_id = '22222222-2222-2222-2222-222222222222' and status = 'pending'))$$,
  'a second admin can approve that same request');

select is(
  (select balance from public.wallets where user_id = '22222222-2222-2222-2222-222222222222'),
  300::numeric(10,2),
  'the first admin''s balance is credited by the second admin''s approval');

-- The self-approval refusal must not mask a more specific error: once the
-- request is resolved, the original admin is told its real status.
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222"}';
select throws_ok(
  $$select public.approve_topup(
      (select id from public.topup_requests
       where user_id = '22222222-2222-2222-2222-222222222222' and amount = 300))$$,
  'P0001', 'top-up already approved',
  'an already-approved own request reports its real status, not the self-approval refusal');

-- Rejecting your own request stays allowed: nothing moves, and it is the way
-- out of the one-pending-per-user rule after a mistaken request.
select lives_ok(
  $$select public.request_topup(200, null, '22222222-2222-2222-2222-222222222222/b.jpg')$$,
  'an admin can submit a corrected request once the previous one is resolved');

select lives_ok(
  $$select public.reject_topup(
      (select id from public.topup_requests
       where user_id = '22222222-2222-2222-2222-222222222222' and status = 'pending'),
      'Entered the wrong amount')$$,
  'an admin can reject their own request');

select is(
  (select status from public.topup_requests
   where user_id = '22222222-2222-2222-2222-222222222222' and amount = 200),
  'rejected',
  'the admin''s own rejected request is recorded as rejected');

-- ===== A customer whose wallet row is missing still gets credited =====
-- ensure_wallet is the belt-and-braces path: a credit can never be applied to
-- a missing row, so approval creates the wallet on demand. The amount is the
-- cap exactly, which also pins the upper bound as inclusive.
reset role;
delete from public.wallets where user_id = '33333333-3333-3333-3333-333333333333';

set local role authenticated;
set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333"}';
select lives_ok(
  $$select public.request_topup(10000, null, '33333333-3333-3333-3333-333333333333/b.jpg')$$,
  'a customer with no wallet row can request a top-up of exactly the cap');

set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222"}';
select lives_ok(
  $$select public.approve_topup(
      (select id from public.topup_requests
       where user_id = '33333333-3333-3333-3333-333333333333'))$$,
  'admin can approve for a customer with no wallet row');

select is(
  (select balance from public.wallets where user_id = '33333333-3333-3333-3333-333333333333'),
  10000::numeric(10,2),
  'approval created the missing wallet and credited the full cap');

-- ===== Storage policies on topup-proofs =====
-- Alice's proof is placed by the table owner (the upload path is exercised by
-- Bob below); what matters here is who can see and touch it afterwards.
reset role;
insert into storage.objects (bucket_id, name)
values ('topup-proofs', '11111111-1111-1111-1111-111111111111/p.jpg');

set local role authenticated;
set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333"}';

select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('topup-proofs', '11111111-1111-1111-1111-111111111111/evil.jpg')$$,
  '42501', null,
  'a customer cannot upload into another customer''s folder');

select lives_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('topup-proofs', '33333333-3333-3333-3333-333333333333/own.jpg')$$,
  'a customer can upload into their own folder');

-- The owner half of "own or admin": without this a policy narrowed to
-- admin-only would still pass every other read assertion.
select is(
  (select count(*)::int from storage.objects
   where bucket_id = 'topup-proofs'
     and name = '33333333-3333-3333-3333-333333333333/own.jpg'),
  1,
  'a customer can see their own proof');

select is(
  (select count(*)::int from storage.objects
   where bucket_id = 'topup-proofs'
     and name like '11111111-1111-1111-1111-111111111111/%'),
  0,
  'a customer cannot see another customer''s proof');

-- The data-modifying CTEs have to be top level, so each assertion wraps its
-- CTE rather than the other way round.
with u as (
  update storage.objects set metadata = '{}'::jsonb
  where bucket_id = 'topup-proofs'
    and name = '33333333-3333-3333-3333-333333333333/own.jpg'
  returning 1)
select is(
  (select count(*)::int from u),
  1,
  'a customer can overwrite their own proof');

select throws_ok(
  $$update storage.objects
    set name = '11111111-1111-1111-1111-111111111111/moved.jpg'
    where bucket_id = 'topup-proofs'
      and name = '33333333-3333-3333-3333-333333333333/own.jpg'$$,
  '42501', null,
  'a customer cannot move their own proof into another customer''s folder');

-- Run as the ADMIN on purpose. UPDATE ... WHERE is filtered by the SELECT
-- policy as well as the UPDATE policy, so a customer who cannot see Alice's
-- row gets zero rows whatever the update policy says. The admin can see it
-- but has no update allowance, so zero here isolates the update policy.
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222"}';
with u as (
  update storage.objects set metadata = '{}'::jsonb
  where bucket_id = 'topup-proofs'
    and name = '11111111-1111-1111-1111-111111111111/p.jpg'
  returning 1)
select is(
  (select count(*)::int from u),
  0,
  'even an admin who can see a proof cannot overwrite it');

select is(
  (select count(*)::int from storage.objects where bucket_id = 'topup-proofs'),
  2,
  'an admin can see every customer''s proof');

-- ===== Standing invariant: balance is the sum of the ledger =====
reset role;
select is(
  (select count(*)::int from public.wallets w
   where w.balance <> coalesce(
     (select sum(e.amount) from public.wallet_entries e where e.user_id = w.user_id), 0)),
  0,
  'every wallet balance equals the sum of its ledger entries');

select * from finish();
rollback;
