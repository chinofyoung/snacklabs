create extension if not exists pgtap with schema extensions;
begin;
select plan(28);

-- Tables exist
select has_table('public', 'wallets', 'wallets table exists');
select has_table('public', 'wallet_entries', 'wallet_entries table exists');
select has_table('public', 'topup_requests', 'topup_requests table exists');

-- A new auth user gets a profile AND a wallet, via handle_new_user
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values ('11111111-1111-1111-1111-111111111111',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'alice@goabroad.com', '{"full_name":"Alice"}'::jsonb, now(), now());

select is(
  (select balance from public.wallets where user_id = '11111111-1111-1111-1111-111111111111'),
  0::numeric(10,2),
  'new user gets a wallet at zero');

-- balance >= 0 is enforced by the database, not just by code
select throws_ok(
  $$update public.wallets set balance = -1
    where user_id = '11111111-1111-1111-1111-111111111111'$$,
  '23514',
  null,
  'negative balance is rejected by the check constraint');

-- One pending top-up per user
insert into public.topup_requests (user_id, amount, proof_path, status)
values ('11111111-1111-1111-1111-111111111111', 100, 'a/b.jpg', 'pending');

select throws_ok(
  $$insert into public.topup_requests (user_id, amount, proof_path, status)
    values ('11111111-1111-1111-1111-111111111111', 50, 'a/c.jpg', 'pending')$$,
  '23505',
  null,
  'a second pending top-up is rejected');


-- Partial index: non-pending rows are unconstrained, so a user can hold a
-- pending request alongside resolved ones.
select lives_ok(
  $$insert into public.topup_requests (user_id, amount, proof_path, status)
    values ('11111111-1111-1111-1111-111111111111', 25, 'a/e.jpg', 'approved')$$,
  'a resolved request can coexist with a pending one (index is partial)');
select lives_ok(
  $$insert into public.topup_requests (user_id, amount, proof_path, status)
    values ('11111111-1111-1111-1111-111111111111', 10000, 'a/f.jpg', 'approved')$$,
  'amount of exactly 10000 is accepted');
select throws_ok(
  $$insert into public.topup_requests (user_id, amount, proof_path, status)
    values ('11111111-1111-1111-1111-111111111111', 10000.01, 'a/g.jpg', 'approved')$$,
  '23514',
  'new row for relation "topup_requests" violates check constraint "topup_requests_amount_check"',
  'amount just above the cap is rejected by the amount check');
select throws_ok(
  $$insert into public.topup_requests (user_id, amount, proof_path, status)
    values ('11111111-1111-1111-1111-111111111111', 0, 'a/h.jpg', 'approved')$$,
  '23514',
  'new row for relation "topup_requests" violates check constraint "topup_requests_amount_check"',
  'zero amount is rejected');
select throws_ok(
  $$insert into public.topup_requests (user_id, amount, proof_path, status)
    values ('11111111-1111-1111-1111-111111111111', -5, 'a/i.jpg', 'approved')$$,
  '23514',
  'new row for relation "topup_requests" violates check constraint "topup_requests_amount_check"',
  'negative amount is rejected');

-- Amount cap
select throws_ok(
  $$insert into public.topup_requests (user_id, amount, proof_path, status)
    values ('11111111-1111-1111-1111-111111111111', 10001, 'a/d.jpg', 'approved')$$,
  '23514',
  null,
  'amount above the 10000 cap is rejected');

-- Clients have no direct write path to balances
select ok(
  not has_table_privilege('authenticated', 'public.wallets', 'UPDATE'),
  'authenticated cannot update wallets directly');

select table_privs_are('public','wallets','authenticated', array['SELECT']::text[], 'authenticated holds SELECT only on wallets');
select table_privs_are('public','wallets','anon', array[]::text[], 'anon holds nothing on wallets');
select table_privs_are('public','wallet_entries','authenticated', array['SELECT']::text[], 'authenticated holds SELECT only on wallet_entries');
select table_privs_are('public','wallet_entries','anon', array[]::text[], 'anon holds nothing on wallet_entries');
select table_privs_are('public','topup_requests','authenticated', array['SELECT']::text[], 'authenticated holds SELECT only on topup_requests');
select table_privs_are('public','topup_requests','anon', array[]::text[], 'anon holds nothing on topup_requests');

select throws_ok(
  $$insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values ('44444444-4444-4444-4444-444444444444',
            '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'eve@example.com', '{}'::jsonb, now(), now())$$,
  'P0001',
  'Only goabroad.com accounts or invited addresses may sign in',
  'a non-goabroad, non-allowlisted email is still rejected');
insert into public.email_allowlist (email) values ('guest@example.org');
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values ('55555555-5555-5555-5555-555555555555',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'Guest@Example.org', '{}'::jsonb, now(), now());
select is(
  (select count(*)::int from public.wallets where user_id = '55555555-5555-5555-5555-555555555555'),
  1,
  'an allowlisted address is accepted and gets a wallet');

-- RLS: one customer cannot read another's wallet. Bob is a second real user
-- rather than a bare uuid because the select policy compares against
-- auth.uid(), so the JWT claim has to name someone who exists.
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values ('33333333-3333-3333-3333-333333333333',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'bob@goabroad.com', '{"full_name":"Bob"}'::jsonb, now(), now());


-- Admin fixture: created via handle_new_user like everyone else, then promoted.
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values ('22222222-2222-2222-2222-222222222222',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'admin@goabroad.com', '{"full_name":"Admin"}'::jsonb, now(), now());
update public.profiles set is_admin = true where id = '22222222-2222-2222-2222-222222222222';

-- A ledger row for Alice so there is something to read on wallet_entries.
insert into public.wallet_entries (user_id, amount, kind, note)
values ('11111111-1111-1111-1111-111111111111', 100, 'topup', 'fixture');

set local role authenticated;
set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333"}';

select is(
  (select count(*)::int from public.wallets
   where user_id = '11111111-1111-1111-1111-111111111111'),
  0,
  'a customer cannot read another customer''s wallet');


-- Positive control for the claim itself: Bob sees exactly one of the three
-- fixture wallets, his own. 0 would mean the policy denies everything (or
-- auth.uid() never matched); 2 or 3 would mean it leaks.
select is(
  (select count(*)::int from public.wallets
   where user_id in ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333')),
  1,
  'a customer reads exactly their own wallet');

select is(
  (select count(*)::int from public.wallet_entries where user_id = '11111111-1111-1111-1111-111111111111'),
  0,
  'a customer cannot read another customer''s ledger entries');

select is(
  (select count(*)::int from public.topup_requests where user_id = '11111111-1111-1111-1111-111111111111'),
  0,
  'a customer cannot read another customer''s top-up requests');

-- Admin: same role, different claim.
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222"}';

select is(
  (select count(*)::int from public.wallets
   where user_id in ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333')),
  3,
  'an admin reads every wallet');

select is(
  (select count(*)::int from public.wallet_entries where user_id = '11111111-1111-1111-1111-111111111111'),
  1,
  'an admin reads other users'' ledger entries');

select is(
  (select count(*)::int from public.topup_requests
   where user_id = '11111111-1111-1111-1111-111111111111' and proof_path = 'a/b.jpg'),
  1,
  'an admin reads other users'' top-up requests');

reset role;

select * from finish();
rollback;
