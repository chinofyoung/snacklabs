create extension if not exists pgtap with schema extensions;
begin;
select plan(13);

-- Alice and Bob are customers, Admin the reader of the figure. @goabroad.com
-- is required by handle_new_user, which also provisions each wallet.
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values ('11111111-1111-1111-1111-111111111111',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'alice@goabroad.com', '{"full_name":"Alice"}'::jsonb, now(), now()),
       ('22222222-2222-2222-2222-222222222222',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'admin@goabroad.com', '{"full_name":"Admin"}'::jsonb, now(), now()),
       ('33333333-3333-3333-3333-333333333333',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'bob@goabroad.com', '{"full_name":"Bob"}'::jsonb, now(), now());
update public.profiles set is_admin = true
where id = '22222222-2222-2222-2222-222222222222';

-- A local database can hold wallets from earlier manual use. Everything here is
-- rolled back, so clear them: the literal totals below must be the sum of
-- exactly these three wallets and nothing else.
delete from public.wallets
where user_id not in ('11111111-1111-1111-1111-111111111111',
                      '22222222-2222-2222-2222-222222222222',
                      '33333333-3333-3333-3333-333333333333');

-- Two wallets credited different amounts, so a wrong sum (one row, the
-- average, the max) cannot land on the right number by coincidence. Admin's
-- own wallet stays at 0.
update public.wallets set balance = 125.50 where user_id = '11111111-1111-1111-1111-111111111111';
update public.wallets set balance = 40.25 where user_id = '33333333-3333-3333-3333-333333333333';

-- ===== Who may execute it =====
-- Supabase's default privileges hand EXECUTE on every new public function to
-- PUBLIC and, separately, to anon, so "signed-in users only" has to be made
-- true, not assumed. Asserted from the catalog so a regression is caught even
-- where no one thinks to call it as anon.
select is(
  (select count(*)::int
   from pg_proc p
   cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
   where p.oid = 'public.total_wallet_balance()'::regprocedure
     and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  0,
  'PUBLIC has no EXECUTE on total_wallet_balance');

-- has_function_privilege resolves PUBLIC and anon's own grant together, so it
-- fails if either one is left in place.
select is(
  has_function_privilege('anon', 'public.total_wallet_balance()', 'EXECUTE'),
  false,
  'anon cannot execute total_wallet_balance');

select is(
  has_function_privilege('authenticated', 'public.total_wallet_balance()', 'EXECUTE'),
  true,
  'authenticated can execute total_wallet_balance');

-- Security definer is what lets the sum read every wallet whatever RLS says,
-- so the search_path pin is what stops it being hijacked by a shadowing object.
select is(
  (select prosecdef and proconfig @> array['search_path=public']
   from pg_proc where oid = 'public.total_wallet_balance()'::regprocedure),
  true,
  'total_wallet_balance is security definer with search_path pinned to public');

-- ===== Admin gets the true sum =====
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222"}';

select is(
  public.total_wallet_balance(),
  165.75::numeric,
  'an admin gets the sum of every wallet (125.50 + 40.25 + 0)');

select is(
  public.total_wallet_balance(),
  (select sum(balance) from public.wallets),
  'the figure equals the sum read straight from wallets');

-- ===== Past PostgREST's 1000-row cap =====
-- The reason this is a function and not a client-side sum: a browser read stops
-- at 1000 rows and would understate the liability without any error. Provision
-- 1100 more customers (handle_new_user creates their wallets) at 1.00 each.
reset role;
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
select gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       'bulk' || n || '@goabroad.com', '{"full_name":"Bulk"}'::jsonb, now(), now()
from generate_series(1, 1100) n;
update public.wallets set balance = 1.00
where user_id not in ('11111111-1111-1111-1111-111111111111',
                      '22222222-2222-2222-2222-222222222222',
                      '33333333-3333-3333-3333-333333333333');

set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222"}';

select cmp_ok(
  (select count(*) from public.wallets), '>', 1000::bigint,
  'there are more wallet rows than a PostgREST read would return');

select is(
  public.total_wallet_balance(),
  1265.75::numeric,
  'the figure counts every wallet past 1000 rows (165.75 + 1100 x 1.00)');

-- ===== Non-admins are refused =====
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111"}';
select throws_ok(
  $$select public.total_wallet_balance()$$,
  'P0001', 'forbidden',
  'a customer cannot read the total, even with a funded wallet of their own');

set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333"}';
select throws_ok(
  $$select public.total_wallet_balance()$$,
  'P0001', 'forbidden',
  'a second customer cannot read the total either');

-- ===== anon is refused at the function boundary =====
-- Claims are cleared, not left as Bob's, so a pass here cannot be a side
-- effect of a stale identity.
reset role;
set local role anon;
set local request.jwt.claims = '';
select throws_ok(
  $$select public.total_wallet_balance()$$,
  '42501', null,
  'anon is refused permission to read the total');

-- ===== A real zero is 0, never null =====
reset role;
update public.wallets set balance = 0;
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222"}';
select is(
  public.total_wallet_balance(),
  0::numeric,
  'with every wallet empty the total is 0');

-- sum() over no rows is null, which is why the function coalesces: the admin
-- tile must be able to tell "nobody holds any balance" from "unknown".
reset role;
delete from public.wallets;
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222"}';
select is(
  public.total_wallet_balance(),
  0::numeric,
  'with no wallets at all the total is 0, not null');

select * from finish();
rollback;
