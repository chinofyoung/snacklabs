create extension if not exists pgtap with schema extensions;
begin;
select plan(111);

-- Alice is the customer, Admin the reviewer, Bob a second customer used for
-- the cross-customer check. @goabroad.com is required by handle_new_user,
-- which also provisions each user's wallet row.
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

insert into public.items (id, name, price, stock, category)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'Piattos', 30, 100, 'snacks');

-- A QR-style method, for the orders that must NOT touch the wallet.
insert into public.payment_methods (id, label, type, account_name, account_number, qr_image_url)
values ('bbbbbbbb-0000-0000-0000-000000000001', 'GCash', 'ewallet', 'Pantry', '0917', 'http://x/q.png');

select id as wallet_pm from public.payment_methods where type = 'wallet' \gset

-- ===== The seeded wallet payment method =====
select is(
  (select count(*)::int from public.payment_methods where type = 'wallet'),
  1,
  'exactly one wallet payment method is seeded');

-- It ships OFF. This is asserted on the row exactly as the migration left it,
-- before anything below touches it: a migration that lands ahead of the
-- frontend that understands type = 'wallet' must not put a half-working
-- method in front of customers on the old bundle.
select is(
  (select is_active from public.payment_methods where type = 'wallet'),
  false,
  'the wallet payment method is seeded inactive');

-- Fixture, not behaviour: everything below exercises the wallet as a LIVE
-- method, i.e. after an admin has switched it on. Stated here so no test
-- depends on the seed's state by accident -- in particular the deactivate
-- assertions further down, which would pass vacuously against a row that
-- started out inactive.
update public.payment_methods set is_active = true where type = 'wallet';

-- ===== Who may execute what =====
-- Supabase's default privileges hand EXECUTE on every new public function to
-- PUBLIC and to anon/authenticated/service_role, so "only signed-in users may
-- call this" has to be made true, not assumed. Asserted from the catalog so a
-- regression is caught even where no one thinks to call it as anon.
select is(
  (select count(*)::int
   from pg_proc p
   cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
   where p.oid = 'public.pay_order_with_wallet(uuid)'::regprocedure
     and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  0,
  'PUBLIC has no EXECUTE on pay_order_with_wallet');

select is(
  has_function_privilege('anon', 'public.pay_order_with_wallet(uuid)', 'EXECUTE'),
  false,
  'anon cannot execute pay_order_with_wallet');

select is(
  has_function_privilege('authenticated', 'public.pay_order_with_wallet(uuid)', 'EXECUTE'),
  true,
  'authenticated can execute pay_order_with_wallet');

-- Trigger functions are invoked by the trigger, never by a client, so nobody
-- needs EXECUTE on them.
select is(
  (select count(*)::int
   from pg_proc p
   cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
   where p.oid = any (array['public.sync_order_wallet()'::regprocedure,
                            'public.release_order_wallet()'::regprocedure,
                            'public.protect_wallet_method()'::regprocedure])
     and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  0,
  'PUBLIC has no EXECUTE on the wallet trigger functions');

select is(
  (select count(*)::int
   from unnest(array['public.sync_order_wallet()',
                     'public.release_order_wallet()',
                     'public.protect_wallet_method()']) f
   cross join unnest(array['anon', 'authenticated']) r
   where has_function_privilege(r, f, 'EXECUTE')),
  0,
  'neither anon nor authenticated can execute the wallet trigger functions');

-- Seed the balance through the LEDGER as well as the cache. A bare
-- `update wallets set balance = 60` would leave sum(wallet_entries) at 0
-- while balance read 60, and the invariant assertions in this file would
-- fail against perfectly correct trigger code.
insert into public.wallet_entries (user_id, amount, kind, note)
values ('11111111-1111-1111-1111-111111111111', 60, 'topup', 'Seed');
update public.wallets set balance = 60
where user_id = '11111111-1111-1111-1111-111111111111';

-- ===== The wallet method is protected from an admin, through RLS =====
-- These run as an admin (not as the session superuser) so they show that what
-- is refused is refused for the real caller, and that what is allowed is
-- allowed through the `pm admin write` policy.
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222"}';

select throws_ok(
  $$delete from public.payment_methods where type = 'wallet'$$,
  'P0001', 'the wallet payment method cannot be deleted; deactivate it instead',
  'the wallet payment method cannot be deleted');

-- Re-typing it would make sync_order_wallet stop recognising it, so confirming
-- an existing wallet order would deduct stock and take no money.
select throws_ok(
  $$update public.payment_methods set type = 'ewallet' where type = 'wallet'$$,
  'P0001', 'the wallet payment method''s type cannot be changed; deactivate it instead',
  'the wallet payment method cannot be re-typed');

select is(
  (select count(*)::int from public.payment_methods where type = 'wallet'),
  1,
  'it is still a wallet method after the refused re-type');

-- Deactivating is the supported way to switch the wallet off, so it must work,
-- and so must relabelling.
-- Each of these is followed by a check of the result: lives_ok on an UPDATE
-- cannot tell "allowed" from "silently filtered to zero rows by RLS".
select lives_ok(
  $$update public.payment_methods set is_active = false where type = 'wallet'$$,
  'an admin can deactivate the wallet payment method');

select is(
  (select is_active from public.payment_methods where type = 'wallet'),
  false,
  'and the wallet payment method is now inactive');

select lives_ok(
  $$update public.payment_methods set label = 'Pantry wallet' where type = 'wallet'$$,
  'an admin can relabel the wallet payment method');

select is(
  (select label from public.payment_methods where type = 'wallet'),
  'Pantry wallet',
  'and the wallet payment method carries the new label');

update public.payment_methods set is_active = true where type = 'wallet';

select is(
  (select is_active from public.payment_methods where type = 'wallet'),
  true,
  'and it can be switched back on');
reset role;

-- ===== anon is refused at the function boundary =====
set local role anon;
select throws_ok(
  $$select public.pay_order_with_wallet('00000000-0000-0000-0000-000000000000')$$,
  '42501', null,
  'anon is refused permission to pay with the wallet');
reset role;

-- ===== Exact-balance purchase (Review Focus 1) =====
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111"}';

select public.create_order(
  '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":2}]'::jsonb,
  :'wallet_pm')
as exact_order \gset

select lives_ok(
  format($$select public.pay_order_with_wallet(%L)$$, :'exact_order'),
  'a purchase for exactly the balance succeeds');

select is(
  (select balance from public.wallets where user_id = '11111111-1111-1111-1111-111111111111'),
  0::numeric(10,2),
  'exact-balance purchase leaves zero, not a rejection');

select is(
  (select status from public.orders where id = :'exact_order'),
  'paid',
  'order is paid');

select is(
  (select count(*)::int from public.wallet_entries
   where order_id = :'exact_order' and kind = 'purchase'),
  1,
  'the purchase wrote exactly one ledger entry');

select is(
  (select amount from public.wallet_entries
   where order_id = :'exact_order' and kind = 'purchase'),
  -60::numeric(10,2),
  'the purchase entry is the negative of the order total');

-- A second call must not debit again. The status guard stops it before the
-- trigger can see a transition.
select throws_ok(
  format($$select public.pay_order_with_wallet(%L)$$, :'exact_order'),
  'order not payable (status paid)',
  'an already-paid order cannot be paid again');

select is(
  (select count(*)::int from public.wallet_entries
   where order_id = :'exact_order' and kind = 'purchase'),
  1,
  'the refused second payment wrote no second purchase entry');

-- ===== Overdraft must raise AND roll back the status change (Review Focus 2) =====
select public.create_order(
  '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":1}]'::jsonb,
  :'wallet_pm')
as broke_order \gset

-- The message is what src/pages/Pay.tsx matches on to show "Not enough
-- balance" with a Top up link, so it is asserted exactly.
select throws_ok(
  format($$select public.pay_order_with_wallet(%L)$$, :'broke_order'),
  'insufficient wallet balance',
  'overdraft is refused');

select is(
  (select status from public.orders where id = :'broke_order'),
  'awaiting_payment',
  'a refused payment leaves the order unpaid, not stranded in paid');

select is(
  (select count(*)::int from public.wallet_entries
   where user_id = '11111111-1111-1111-1111-111111111111'),
  2,
  'a refused payment writes no ledger entry (just the seed and the first purchase)');

-- sync_order_stock fires before sync_order_wallet (trigger name order), so it
-- has already taken stock by the time the wallet refuses. The refusal must
-- give it back with the rest of the rolled-back change: 100 less the 2 bought
-- by the exact-balance order.
select is(
  (select stock from public.items where id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  98,
  'a refused payment does not leave stock deducted');

-- ===== pay_order_with_wallet's own guards =====
set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333"}';
select throws_ok(
  format($$select public.pay_order_with_wallet(%L)$$, :'broke_order'),
  'forbidden',
  'a customer cannot pay another customer''s order');

set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111"}';
select throws_ok(
  $$select public.pay_order_with_wallet('00000000-0000-0000-0000-000000000000')$$,
  'order not found',
  'an unknown order is refused');

set local request.jwt.claims = '{}';
select throws_ok(
  format($$select public.pay_order_with_wallet(%L)$$, :'broke_order'),
  'not authenticated',
  'a session with no subject is refused');

-- ===== Void refunds exactly what was taken, and the invariant holds =====
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222"}';

select lives_ok(
  format($$select public.void_order(%L)$$, :'exact_order'),
  'admin can void a wallet-paid order');

select is(
  (select balance from public.wallets where user_id = '11111111-1111-1111-1111-111111111111'),
  60::numeric(10,2),
  'voiding a wallet-paid order refunds exactly what was taken');

-- order_id is nulled by the FK once the order is deleted, so the refund is
-- found through the note that carries the order reference forward.
select is(
  (select count(*)::int from public.wallet_entries
   where kind = 'refund' and amount = 60
     and note like '%order #' || left(:'exact_order', 8)),
  1,
  'the void wrote exactly one refund entry, for the full amount');

-- balance always equals sum(entries)
-- After seed(+60), purchase(-60), refund(+60): both sides are 60.
select is(
  (select balance from public.wallets where user_id = '11111111-1111-1111-1111-111111111111'),
  (select coalesce(sum(amount), 0)::numeric(10,2) from public.wallet_entries
   where user_id = '11111111-1111-1111-1111-111111111111'),
  'balance equals sum(wallet_entries.amount)');

-- ===== Review Focus 5: an order that was never wallet-paid credits nothing =====
-- A spurious refund here would be free money.
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111"}';

select public.create_order(
  '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":1}]'::jsonb,
  'bbbbbbbb-0000-0000-0000-000000000001') as qr_order \gset

-- Alice holds a balance here, so a QR order that slipped through would be
-- paid out of it.
select throws_ok(
  format($$select public.pay_order_with_wallet(%L)$$, :'qr_order'),
  'this order is not set to pay from your wallet',
  'a QR-method order cannot be paid from the wallet');

select is(
  (select status from public.orders where id = :'qr_order'),
  'awaiting_payment',
  'the refused QR order is left awaiting payment');

set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222"}';

select lives_ok(
  format($$update public.orders set status = 'paid' where id = %L$$, :'qr_order'),
  'admin can mark a QR order paid');

select is(
  (select balance from public.wallets where user_id = '11111111-1111-1111-1111-111111111111'),
  60::numeric(10,2),
  'a QR order marked paid takes nothing from the wallet');

select lives_ok(
  format($$select public.void_order(%L)$$, :'qr_order'),
  'admin can void a QR-paid order');

select is(
  (select balance from public.wallets where user_id = '11111111-1111-1111-1111-111111111111'),
  60::numeric(10,2),
  'voiding a QR-paid order credits nothing');

select is(
  (select count(*)::int from public.wallet_entries
   where user_id = '11111111-1111-1111-1111-111111111111'),
  3,
  'the QR order left no ledger entries (just seed, purchase and refund)');

-- The same, through the plain-update path that AdminOrders.tsx's reject()
-- takes: there it is sync_order_wallet, not release_order_wallet, that decides
-- whether anything is refunded.
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111"}';

select public.create_order(
  '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":1}]'::jsonb,
  'bbbbbbbb-0000-0000-0000-000000000001') as qr_cancel \gset

set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222"}';

select lives_ok(
  format($$update public.orders set status = 'paid' where id = %L$$, :'qr_cancel'),
  'admin marks another QR order paid');

select lives_ok(
  format($$update public.orders set status = 'cancelled' where id = %L$$, :'qr_cancel'),
  'admin rejects the QR-paid order with a plain status update');

select is(
  (select balance from public.wallets where user_id = '11111111-1111-1111-1111-111111111111'),
  60::numeric(10,2),
  'rejecting a QR-paid order with a plain update credits nothing');

select is(
  (select count(*)::int from public.wallet_entries
   where user_id = '11111111-1111-1111-1111-111111111111'),
  3,
  'and writes no ledger entry');

-- ===== The plain-update reject path, and paying the same order twice =====
-- AdminOrders.tsx's reject() is a plain `update orders set status =
-- 'cancelled'`, not an RPC, and runs as `authenticated` (a role with no
-- EXECUTE on the trigger functions). The refund must still happen.
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111"}';

select public.create_order(
  '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":1}]'::jsonb,
  :'wallet_pm')
as w2 \gset

select lives_ok(
  format($$select public.pay_order_with_wallet(%L)$$, :'w2'),
  'a wallet order can be paid');

select is(
  (select balance from public.wallets where user_id = '11111111-1111-1111-1111-111111111111'),
  30::numeric(10,2),
  'paying a 30 order from 60 leaves 30');

set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222"}';

select lives_ok(
  format($$update public.orders set status = 'cancelled' where id = %L$$, :'w2'),
  'admin can reject a wallet-paid order with a plain status update');

select is(
  (select balance from public.wallets where user_id = '11111111-1111-1111-1111-111111111111'),
  60::numeric(10,2),
  'the plain-update reject path refunds the wallet');

-- Put it back to awaiting payment so Alice can pay it a second time. Each
-- payment and refund is a real journal entry, which is why wallet_entries has
-- no uniqueness on order_id.
select lives_ok(
  format($$update public.orders set status = 'awaiting_payment' where id = %L$$, :'w2'),
  'admin can reopen a rejected order');

set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111"}';

select lives_ok(
  format($$select public.pay_order_with_wallet(%L)$$, :'w2'),
  'the same order can be paid a second time after a refund');

select is(
  (select balance from public.wallets where user_id = '11111111-1111-1111-1111-111111111111'),
  30::numeric(10,2),
  'the second payment debits again');

select is(
  (select count(*)::int from public.wallet_entries where order_id = :'w2'),
  3,
  'paid, refunded and paid again leaves three ledger entries');

set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222"}';

select lives_ok(
  format($$select public.void_order(%L)$$, :'w2'),
  'admin can void the twice-paid order');

-- The ledger for this order nets to -30 (-30, +30, -30), so exactly 30 comes
-- back. Refunding the sum of the purchase entries alone would return 60.
select is(
  (select balance from public.wallets where user_id = '11111111-1111-1111-1111-111111111111'),
  60::numeric(10,2),
  'voiding refunds what is outstanding on the ledger, not the sum of purchases');

select is(
  (select count(*)::int from public.wallet_entries
   where kind = 'refund' and note like '%order #' || left(:'w2', 8)),
  2,
  'the reject and the void each wrote one refund');

-- ===== The refund follows the ledger, not the payment method's current state =====
-- Each case runs through BOTH refund paths: void_order (release_order_wallet,
-- on delete) and a plain status update (sync_order_wallet, on update).
--
-- (a) The wallet method is deactivated after orders were paid with it. The
-- refund must still be exact. (It cannot be re-typed any more, see the
-- protection assertions at the top, so deactivation is the edit left.)
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111"}';

select public.create_order(
  '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":1}]'::jsonb,
  :'wallet_pm')
as w3 \gset
select public.create_order(
  '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":1}]'::jsonb,
  :'wallet_pm')
as w5 \gset

select lives_ok(
  format($$select public.pay_order_with_wallet(%L)$$, :'w3'),
  'a wallet order is paid before its method is deactivated');
select lives_ok(
  format($$select public.pay_order_with_wallet(%L)$$, :'w5'),
  'a second wallet order is paid before its method is deactivated');

reset role;
update public.payment_methods set is_active = false where id = :'wallet_pm';
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222"}';

select lives_ok(
  format($$select public.void_order(%L)$$, :'w3'),
  'admin can void an order whose wallet method has since been deactivated');

select is(
  (select balance from public.wallets where user_id = '11111111-1111-1111-1111-111111111111'),
  30::numeric(10,2),
  'the void refund is exact even after the method was deactivated');

select lives_ok(
  format($$update public.orders set status = 'cancelled' where id = %L$$, :'w5'),
  'admin can reject an order whose wallet method has since been deactivated');

select is(
  (select balance from public.wallets where user_id = '11111111-1111-1111-1111-111111111111'),
  60::numeric(10,2),
  'the plain-update refund is exact even after the method was deactivated');

reset role;
update public.payment_methods set is_active = true where id = :'wallet_pm';

-- (b) The reverse: orders paid by QR, whose method is later re-typed as a
-- wallet. Deciding the refund from the method's type (or from orders.total)
-- would mint 30 out of nothing on either path; the ledger nets to zero, so
-- nothing is paid.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111"}';

select public.create_order(
  '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":1}]'::jsonb,
  'bbbbbbbb-0000-0000-0000-000000000001') as q2 \gset
select public.create_order(
  '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":1}]'::jsonb,
  'bbbbbbbb-0000-0000-0000-000000000001') as q3 \gset

set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222"}';

select lives_ok(
  format($$update public.orders set status = 'paid' where id = %L$$, :'q2'),
  'admin marks the second QR order paid');
select lives_ok(
  format($$update public.orders set status = 'paid' where id = %L$$, :'q3'),
  'admin marks the third QR order paid');

reset role;
update public.payment_methods set type = 'wallet' where id = 'bbbbbbbb-0000-0000-0000-000000000001';
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222"}';

select lives_ok(
  format($$select public.void_order(%L)$$, :'q2'),
  'admin can void it after its method was re-typed as a wallet');

select is(
  (select balance from public.wallets where user_id = '11111111-1111-1111-1111-111111111111'),
  60::numeric(10,2),
  're-typing a payment method after the fact cannot mint a refund on void');

select lives_ok(
  format($$update public.orders set status = 'cancelled' where id = %L$$, :'q3'),
  'admin can reject the other one after its method was re-typed as a wallet');

select is(
  (select balance from public.wallets where user_id = '11111111-1111-1111-1111-111111111111'),
  60::numeric(10,2),
  're-typing a payment method after the fact cannot mint a refund on a plain update');

-- Put the QR method back. protect_wallet_method refuses to turn a method that
-- IS a wallet method into anything else, and it fires whatever role runs the
-- statement, so after (b) the QR method cannot be restored without disabling
-- the guard around the restore. Leaving it re-typed would leave two rows with
-- type = 'wallet' for the rest of the file and break the shape of the
-- "exactly one wallet method" assertions at the top and bottom.
reset role;
alter table public.payment_methods disable trigger protect_wallet_method;
update public.payment_methods set type = 'ewallet' where id = 'bbbbbbbb-0000-0000-0000-000000000001';
alter table public.payment_methods enable trigger protect_wallet_method;

-- ===== delete_all_orders refunds through the same trigger =====
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111"}';

select public.create_order(
  '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":1}]'::jsonb,
  :'wallet_pm')
as w4 \gset

select lives_ok(
  format($$select public.pay_order_with_wallet(%L)$$, :'w4'),
  'a wallet order is paid before the bulk delete');

set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222"}';

select lives_ok(
  $$select public.delete_all_orders()$$,
  'admin can delete all orders');

select is(
  (select balance from public.wallets where user_id = '11111111-1111-1111-1111-111111111111'),
  60::numeric(10,2),
  'delete_all_orders refunds the wallet-paid order');

-- ===== A zero total debits nothing; a negative total can never exist =====
reset role;
insert into public.items (id, name, price, stock, category)
values ('aaaaaaaa-0000-0000-0000-000000000002', 'Freebie', 0, 5, 'snacks');

set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111"}';

select public.create_order(
  '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000002","qty":1}]'::jsonb,
  :'wallet_pm')
as free_order \gset

select lives_ok(
  format($$select public.pay_order_with_wallet(%L)$$, :'free_order'),
  'a zero-total wallet order can be paid');

select is(
  (select status from public.orders where id = :'free_order'),
  'paid',
  'the zero-total order is paid');

select is(
  (select count(*)::int from public.wallet_entries where order_id = :'free_order'),
  0,
  'a zero total writes no ledger entry');

select is(
  (select balance from public.wallets where user_id = '11111111-1111-1111-1111-111111111111'),
  60::numeric(10,2),
  'and moves no money');

set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222"}';

select throws_ok(
  format($$update public.orders set total = -10 where id = %L$$, :'free_order'),
  '23514', null,
  'an order total cannot be set negative');

-- ===== Money is conserved =====
reset role;
-- Every purchase so far was voided or refunded, so the only net movement left
-- in Alice's ledger is the 60 that was seeded.
select is(
  (select sum(amount) from public.wallet_entries
   where user_id = '11111111-1111-1111-1111-111111111111'),
  60::numeric(10,2),
  'after a full purchase and refund history the ledger nets to the seed');

-- ===== A refund goes to the user who was debited, not whoever owns the order now =====
-- `orders admin update` lets an admin change orders.user_id. Both wallets
-- would still satisfy balance = sum(entries) if a reassigned order were
-- refunded to its new owner, so only an explicit assertion catches it.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111"}';

select public.create_order(
  '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":1}]'::jsonb,
  :'wallet_pm')
as w6 \gset
select public.create_order(
  '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":1}]'::jsonb,
  :'wallet_pm')
as w7 \gset

select lives_ok(
  format($$select public.pay_order_with_wallet(%L)$$, :'w6'),
  'Alice pays one order that will be reassigned');
select lives_ok(
  format($$select public.pay_order_with_wallet(%L)$$, :'w7'),
  'Alice pays another that will be reassigned');

set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222"}';

select lives_ok(
  format($$update public.orders set user_id = '33333333-3333-3333-3333-333333333333' where id = %L$$, :'w6'),
  'admin reassigns a paid wallet order to Bob');
select lives_ok(
  format($$update public.orders set status = 'cancelled' where id = %L$$, :'w6'),
  'admin cancels the reassigned order with a plain update');

select is(
  (select balance from public.wallets where user_id = '33333333-3333-3333-3333-333333333333'),
  0::numeric(10,2),
  'the plain-update refund does not credit the new owner');
select is(
  (select count(*)::int from public.wallet_entries where user_id = '33333333-3333-3333-3333-333333333333'),
  0,
  'and writes no ledger entry for the new owner');

select lives_ok(
  format($$update public.orders set user_id = '33333333-3333-3333-3333-333333333333' where id = %L$$, :'w7'),
  'admin reassigns the other paid order to Bob');
select lives_ok(
  format($$select public.void_order(%L)$$, :'w7'),
  'admin voids the reassigned order');

select is(
  (select balance from public.wallets where user_id = '33333333-3333-3333-3333-333333333333'),
  0::numeric(10,2),
  'the void refund does not credit the new owner');
select is(
  (select count(*)::int from public.wallet_entries where user_id = '33333333-3333-3333-3333-333333333333'),
  0,
  'and writes no ledger entry for the new owner');

-- ===== Belt and braces: a negative total can never credit the wallet =====
-- orders_total_nonneg normally makes this unreachable, so it is dropped here
-- (inside the test's transaction, undone by its rollback) to prove the debit
-- branch refuses to act on a non-positive total by itself. Alice's balance is
-- 0 at this point (the two reassigned orders above stay debited to her).
reset role;
alter table public.orders drop constraint if exists orders_total_nonneg;

set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111"}';

select public.create_order(
  '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":1}]'::jsonb,
  :'wallet_pm')
as neg_order \gset

reset role;
update public.orders set total = -10 where id = :'neg_order';
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111"}';

select lives_ok(
  format($$select public.pay_order_with_wallet(%L)$$, :'neg_order'),
  'a negative-total order does not blow up the payment path');

select is(
  (select balance from public.wallets where user_id = '11111111-1111-1111-1111-111111111111'),
  0::numeric(10,2),
  'a negative total cannot credit the wallet through the debit branch');

select is(
  (select count(*)::int from public.wallet_entries where order_id = :'neg_order'),
  0,
  'and writes no positive purchase entry');

-- ===== A blocked customer cannot spend their balance =====
-- Blocking does not cancel outstanding orders, so Bob holds an
-- awaiting_payment wallet order and a balance from before he is blocked.
-- Seeded through the ledger and the cache, as for Alice.
reset role;
insert into public.wallet_entries (user_id, amount, kind, note)
values ('33333333-3333-3333-3333-333333333333', 30, 'topup', 'Seed');
update public.wallets set balance = balance + 30
where user_id = '33333333-3333-3333-3333-333333333333';

set local role authenticated;
set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333"}';

select public.create_order(
  '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":1}]'::jsonb,
  :'wallet_pm')
as bobs_order \gset

reset role;
update public.profiles set is_blocked = true where id = '33333333-3333-3333-3333-333333333333';
set local role authenticated;
set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333"}';

select throws_ok(
  format($$select public.pay_order_with_wallet(%L)$$, :'bobs_order'),
  'access revoked',
  'a blocked customer cannot spend their balance');

select is(
  (select status from public.orders where id = :'bobs_order'),
  'awaiting_payment',
  'the blocked customer''s order is left unpaid');

select is(
  (select balance from public.wallets where user_id = '33333333-3333-3333-3333-333333333333'),
  30::numeric(10,2),
  'and their balance is untouched');

select throws_ok(
  $$select public.request_topup(10, null, '33333333-3333-3333-3333-333333333333/p.jpg')$$,
  'access revoked',
  'a blocked customer cannot request a top-up');

-- ===== confirm_order on a wallet order (AdminOrders.tsx "Approve & mark paid") =====
-- AdminOrders.tsx offers "Approve & mark paid" for ANY awaiting_payment order,
-- wallet orders included, and that button calls confirm_order. That is a second
-- way to take a wallet order to 'paid' besides pay_order_with_wallet, and it
-- reaches the debit only through sync_order_wallet. confirm_order is not
-- wallet-aware at all, so these cases pin the money to the trigger from the
-- admin's side of the door. Run as an admin, the real caller.
--
-- Funded through the ledger as well as the cache, as for the seeds above.
reset role;
insert into public.wallet_entries (user_id, amount, kind, note)
values ('11111111-1111-1111-1111-111111111111', 100, 'topup', 'Seed');
update public.wallets set balance = balance + 100
where user_id = '11111111-1111-1111-1111-111111111111';

select is(
  (select balance from public.wallets where user_id = '11111111-1111-1111-1111-111111111111'),
  100::numeric(10,2),
  'Alice holds 100 before an admin approves a wallet order for her');

set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111"}';

select public.create_order(
  '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":2}]'::jsonb,
  :'wallet_pm')
as approve_order \gset

set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222"}';

select lives_ok(
  format($$select public.confirm_order(%L, null)$$, :'approve_order'),
  'an admin can approve a wallet order the balance covers');

select is(
  (select status from public.orders where id = :'approve_order'),
  'paid',
  'the approved wallet order is paid');

select is(
  (select balance from public.wallets where user_id = '11111111-1111-1111-1111-111111111111'),
  40::numeric(10,2),
  'approving a 60 wallet order takes exactly 60 from 100');

select is(
  (select count(*)::int from public.wallet_entries
   where order_id = :'approve_order' and kind = 'purchase'),
  1,
  'the approval wrote exactly one purchase entry');

select is(
  (select amount from public.wallet_entries
   where order_id = :'approve_order' and kind = 'purchase'),
  -60::numeric(10,2),
  'and that entry is the negative of the order total');

select is(
  (select balance from public.wallets where user_id = '11111111-1111-1111-1111-111111111111'),
  (select coalesce(sum(amount), 0)::numeric(10,2) from public.wallet_entries
   where user_id = '11111111-1111-1111-1111-111111111111'),
  'balance equals sum(wallet_entries.amount) after the approval');

-- Approving twice must not debit twice: the status guard in confirm_order
-- refuses before the trigger can see a second transition.
select throws_ok(
  format($$select public.confirm_order(%L, null)$$, :'approve_order'),
  'order not confirmable (status paid)',
  'an already-approved wallet order cannot be approved again');

select is(
  (select count(*)::int from public.wallet_entries
   where order_id = :'approve_order' and kind = 'purchase'),
  1,
  'so the wallet was debited exactly once');

-- Insufficient: Alice now holds 40 and this order costs 60. sync_order_stock
-- fires before sync_order_wallet (trigger name order), so stock has been taken
-- by the time the wallet refuses; the refusal must hand it back with the rest
-- of the rolled-back change.
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111"}';

select public.create_order(
  '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":2}]'::jsonb,
  :'wallet_pm')
as short_order \gset

select stock as stock_before from public.items
where id = 'aaaaaaaa-0000-0000-0000-000000000001' \gset

set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222"}';

-- The message is what describePayError (src/lib/wallet.ts) matches on to turn
-- this into a sentence for the admin, so it is asserted exactly.
select throws_ok(
  format($$select public.confirm_order(%L, null)$$, :'short_order'),
  'insufficient wallet balance',
  'approving a wallet order the balance cannot cover is refused');

select is(
  (select status from public.orders where id = :'short_order'),
  'awaiting_payment',
  'a refused approval leaves the order unpaid, not stranded in paid');

select is(
  (select balance from public.wallets where user_id = '11111111-1111-1111-1111-111111111111'),
  40::numeric(10,2),
  'a refused approval leaves the balance untouched');

select is(
  (select count(*)::int from public.wallet_entries where order_id = :'short_order'),
  0,
  'a refused approval writes no ledger entry');

select is(
  (select stock from public.items where id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  :stock_before,
  'a refused approval does not leave stock deducted');

select is(
  (select balance from public.wallets where user_id = '11111111-1111-1111-1111-111111111111'),
  (select coalesce(sum(amount), 0)::numeric(10,2) from public.wallet_entries
   where user_id = '11111111-1111-1111-1111-111111111111'),
  'balance still equals sum(wallet_entries.amount) after the refusal');

-- ===== Standing invariants =====
reset role;
-- The fixture must end the way the first assertion assumed it began: the QR
-- method restored, so exactly one wallet method remains.
select is(
  (select count(*)::int from public.payment_methods where type = 'wallet'),
  1,
  'exactly one wallet payment method exists at the end');

select is(
  (select count(*)::int from public.wallets w
   where w.balance <> coalesce(
     (select sum(e.amount) from public.wallet_entries e where e.user_id = w.user_id), 0)),
  0,
  'every wallet balance equals the sum of its ledger entries');

select * from finish();
rollback;
