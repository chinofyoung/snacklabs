create extension if not exists pgtap with schema extensions;
begin;
select plan(47);

-- claim_push_subscription: a push endpoint belongs to whoever is signed in on
-- that browser now. On a shared device the second person to subscribe must take
-- the endpoint over, and the first person must stop receiving their pushes.

insert into public.allowed_email_domains (domain) values ('example.com') on conflict do nothing;
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values
  ('a0000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','person-a@example.com','{"first_name":"Ann","last_name":"A"}'::jsonb, now(), now()),
  ('b0000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','person-b@example.com','{"first_name":"Ben","last_name":"B"}'::jsonb, now(), now()),
  ('c0000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','person-c@example.com','{"first_name":"Cat","last_name":"C"}'::jsonb, now(), now());

-- ===== Who may execute it =====
select has_function('public', 'claim_push_subscription', array['text','text','text','text'],
  'claim_push_subscription exists');

select is(
  (select count(*)::int
   from pg_proc p
   cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
   where p.oid = 'public.claim_push_subscription(text,text,text,text)'::regprocedure
     and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  0, 'PUBLIC has no EXECUTE on claim_push_subscription');
select is(
  has_function_privilege('anon', 'public.claim_push_subscription(text,text,text,text)', 'EXECUTE'),
  false, 'anon cannot execute claim_push_subscription');
-- Unlike notify_user/notify_admins this is called from the browser, so it must be
-- executable by a signed-in user.
select is(
  has_function_privilege('authenticated', 'public.claim_push_subscription(text,text,text,text)', 'EXECUTE'),
  true, 'authenticated can execute claim_push_subscription');

-- ===== Unauthenticated callers are refused =====
-- Claims are cleared, not left as someone's, so a pass cannot be a stale identity.
set local role anon;
set local request.jwt.claims = '';
select throws_ok(
  $$select public.claim_push_subscription('https://fcm.googleapis.com/fcm/send/shared', 'k', 'a')$$,
  '42501', null,
  'anon is refused permission to claim a subscription');

-- Defence in depth: even holding EXECUTE, a caller with no identity is refused
-- rather than inserting a row owned by nobody.
reset role;
set local role authenticated;
set local request.jwt.claims = '{}';
select throws_ok(
  $$select public.claim_push_subscription('https://fcm.googleapis.com/fcm/send/shared', 'k', 'a')$$,
  'P0001', 'not authenticated',
  'a caller with no identity is refused');

-- ===== Person A subscribes two devices =====
set local request.jwt.claims = '{"sub":"a0000000-0000-0000-0000-00000000000a"}';
do $$
begin
  perform set_config('test.a_shared_id',
    public.claim_push_subscription('https://fcm.googleapis.com/fcm/send/shared', 'key-a', 'auth-a', 'A phone')::text, true);
  perform public.claim_push_subscription('https://fcm.googleapis.com/fcm/send/a-laptop', 'key-a2', 'auth-a2', 'A laptop');
end $$;

select is(
  (select id::text from public.push_subscriptions where endpoint = 'https://fcm.googleapis.com/fcm/send/shared'),
  current_setting('test.a_shared_id'),
  'the returned id is the id of the stored row');
select is(
  (select count(*)::int from public.push_subscriptions where endpoint = 'https://fcm.googleapis.com/fcm/send/shared'),
  1, 'A owns the shared endpoint');

-- ===== Person B picks up the same shared device =====
set local request.jwt.claims = '{"sub":"b0000000-0000-0000-0000-00000000000b"}';
select lives_ok(
  $$select public.claim_push_subscription('https://fcm.googleapis.com/fcm/send/shared', 'key-b', 'auth-b', 'Shared tablet')$$,
  'B can claim an endpoint A already owns, instead of colliding');
select is(
  (select count(*)::int from public.push_subscriptions where endpoint = 'https://fcm.googleapis.com/fcm/send/shared'),
  1, 'B sees the endpoint as their own');

-- ===== A no longer receives anything on that device =====
set local request.jwt.claims = '{"sub":"a0000000-0000-0000-0000-00000000000a"}';
select is(
  (select count(*)::int from public.push_subscriptions where endpoint = 'https://fcm.googleapis.com/fcm/send/shared'),
  0, 'A can no longer see the endpoint B took over');
-- The delete is scoped to the one endpoint: A's other device is untouched.
select is(
  (select count(*)::int from public.push_subscriptions where endpoint = 'https://fcm.googleapis.com/fcm/send/a-laptop'),
  1, 'A keeps their other device');

-- ===== Ground truth, bypassing RLS =====
reset role;
select is(
  (select array_agg(user_id) from public.push_subscriptions where endpoint = 'https://fcm.googleapis.com/fcm/send/shared'),
  array['b0000000-0000-0000-0000-00000000000b']::uuid[],
  'B is the sole owner, with exactly one row for the endpoint');
select is(
  (select p256dh from public.push_subscriptions where endpoint = 'https://fcm.googleapis.com/fcm/send/shared'),
  'key-b', 'the stored keys are B''s, not left over from A');

-- ===== Re-claiming your own endpoint refreshes it =====
-- Browsers rotate subscription keys; a user re-subscribing must not accumulate rows.
set local role authenticated;
set local request.jwt.claims = '{"sub":"b0000000-0000-0000-0000-00000000000b"}';
select lives_ok(
  $$select public.claim_push_subscription('https://fcm.googleapis.com/fcm/send/shared', 'key-b2', 'auth-b2', 'Shared tablet')$$,
  'B can re-claim their own endpoint');
reset role;
select is(
  (select array_agg(p256dh) from public.push_subscriptions where endpoint = 'https://fcm.googleapis.com/fcm/send/shared'),
  array['key-b2'],
  're-claiming leaves a single row carrying the refreshed keys');

-- ===== Which endpoints may be stored =====
-- send-push POSTs to a stored endpoint from inside Supabase's network, so a
-- freely chosen endpoint is a server-side request forgery (and a readable one: a
-- 404/410 prunes the row, and people can see their own rows). Only the browser
-- vendors' push services may be stored. The host is matched in full, not searched
-- for, so the spoofing shapes below must all be refused.
set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-0000-0000-00000000000a"}';

-- Each provider's real endpoint shape is accepted. A false rejection here would
-- mean a person simply cannot turn notifications on.
select lives_ok(
  format('select public.claim_push_subscription(%L, ''k'', ''a'')', endpoint),
  'accepted: ' || provider)
from (values
  ('https://fcm.googleapis.com/fcm/send/dXyz:APA91bExampleToken', 'Chrome (FCM)'),
  ('https://updates.push.services.mozilla.com/wpush/v2/gAAAAABExampleToken', 'Firefox (Mozilla autopush)'),
  ('https://wns2-par02p.notify.windows.com/w/?token=BQYAAAExampleToken', 'Edge (Windows WNS)'),
  ('https://web.push.apple.com/QExampleToken', 'Safari (Apple)')
) as t(endpoint, provider);

select is(
  (select bool_and(public.is_supported_push_endpoint(e)) from unnest(array[
     'https://push.services.mozilla.com/x',
     'https://notify.windows.com/x',
     'https://push.apple.com/x',
     'https://fcm.googleapis.com:443/fcm/send/x',
     'https://fcm.googleapis.com']) e),
  true, 'wildcard apex hosts, an explicit :443 and a bare host are accepted');

-- Everything else is refused with a clear error (invalid_parameter_value).
select throws_ok(
  format('select public.claim_push_subscription(%L, ''k'', ''a'')', endpoint),
  '22023', null,
  'refused: ' || why)
from (values
  ('http://fcm.googleapis.com/fcm/send/x', 'plain http, even on a real push host'),
  ('https://example.com/push', 'an unrelated host'),
  ('https://169.254.169.254/latest/meta-data/', 'the cloud metadata address'),
  ('https://localhost/x', 'localhost'),
  ('https://evil.com/?x=fcm.googleapis.com', 'a push host named only in the query string'),
  ('https://fcm.googleapis.com.evil.com/', 'a push host used as the prefix of another host'),
  ('https://fcm.googleapis.com@evil.com/', 'a push host smuggled in as user-info'),
  ('https://fcm.googleapis.com\@evil.com/', 'a push host followed by a backslash and user-info'),
  ('https://evilpush.services.mozilla.com/x', 'a Mozilla wildcard without a dot boundary'),
  ('https://evilnotify.windows.com/x', 'a Windows wildcard without a dot boundary'),
  ('https://evilpush.apple.com/x', 'an Apple wildcard without a dot boundary'),
  ('https://push.services.mozilla.com.evil.com/x', 'a wildcard host used as the prefix of another host'),
  ('https://fcm.googleapİs.com/x', 'a Unicode lookalike of a push host'),
  ('', 'an empty endpoint'),
  (null, 'a null endpoint')
) as t(endpoint, why);

-- The RPC is not the only way to write this table: RLS grants INSERT and UPDATE,
-- so a client can skip it. The constraint is what makes the rule hold anyway.
select throws_ok(
  $$insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
    values ('a0000000-0000-0000-0000-00000000000a', 'https://169.254.169.254/latest/meta-data/', 'k', 'a')$$,
  '23514', null,
  'a direct INSERT of a non-push-service endpoint is refused too');
select throws_ok(
  $$update public.push_subscriptions set endpoint = 'https://evil.example/x'
    where endpoint = 'https://fcm.googleapis.com/fcm/send/a-laptop'$$,
  '23514', null,
  'so is an UPDATE of an endpoint to one');
reset role;

-- ===== A cap on subscriptions per user =====
-- send-push fans a notification out to every subscription its recipient holds, so
-- an account is limited to 20. Person C fills their quota, one endpoint per device.
set local role authenticated;
set local request.jwt.claims = '{"sub":"c0000000-0000-0000-0000-00000000000c"}';
do $$
begin
  for n in 1..20 loop
    perform public.claim_push_subscription(
      'https://fcm.googleapis.com/fcm/send/c-device-' || n, 'key-c', 'auth-c', 'C device ' || n);
  end loop;
end $$;

select is(
  (select count(*)::int from public.push_subscriptions where user_id = 'c0000000-0000-0000-0000-00000000000c'),
  20, 'C holds exactly 20 subscriptions, the limit');

-- The 21st is refused (program_limit_exceeded) and nothing is written for it.
select throws_ok(
  $$select public.claim_push_subscription('https://fcm.googleapis.com/fcm/send/c-device-21', 'k', 'a')$$,
  '54000', null,
  'the 21st subscription is refused');
select is(
  (select count(*)::int from public.push_subscriptions where endpoint = 'https://fcm.googleapis.com/fcm/send/c-device-21'),
  0, 'a refused claim stores nothing');

-- Re-claiming an endpoint C already owns replaces its row, so it must still work
-- at the limit: the count is taken after the old row is deleted.
select lives_ok(
  $$select public.claim_push_subscription('https://fcm.googleapis.com/fcm/send/c-device-7', 'key-c-rotated', 'auth-c-rotated', 'C device 7')$$,
  'C can re-claim one of their own endpoints while at the limit');
select is(
  (select count(*)::int from public.push_subscriptions where user_id = 'c0000000-0000-0000-0000-00000000000c'),
  20, 're-claiming at the limit leaves C at 20, not 21 or 19');
select is(
  (select p256dh from public.push_subscriptions where endpoint = 'https://fcm.googleapis.com/fcm/send/c-device-7'),
  'key-c-rotated', 'the re-claim refreshed the stored keys');

-- Taking over someone else's endpoint adds a row for C, so at the limit it is
-- refused too, and the refusal must not have deleted A's row on the way.
select throws_ok(
  $$select public.claim_push_subscription('https://fcm.googleapis.com/fcm/send/a-laptop', 'k', 'a')$$,
  '54000', null,
  'C at the limit cannot take over another account''s endpoint');
reset role;
select is(
  (select user_id::text from public.push_subscriptions where endpoint = 'https://fcm.googleapis.com/fcm/send/a-laptop'),
  'a0000000-0000-0000-0000-00000000000a',
  'the refused takeover left A''s subscription in place');

-- The limit is per account: C being full does not stop anyone else.
set local role authenticated;
set local request.jwt.claims = '{"sub":"b0000000-0000-0000-0000-00000000000b"}';
select lives_ok(
  $$select public.claim_push_subscription('https://fcm.googleapis.com/fcm/send/b-second-device', 'k', 'a')$$,
  'another account can still subscribe while C is at the limit');
reset role;

select * from finish();
rollback;
