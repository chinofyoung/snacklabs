create extension if not exists pgtap with schema extensions;
begin;
select plan(21);

-- ===== Shape =====
select has_table('public', 'allowed_email_domains', 'allowed_email_domains table exists');
select hasnt_table('public', 'email_allowlist', 'the old per-address allowlist table no longer exists under its original name (renamed to an archive)');
select has_column('public', 'profiles', 'first_name', 'profiles.first_name exists');
select has_column('public', 'profiles', 'last_name', 'profiles.last_name exists');
select has_column('public', 'profiles', 'approval_status', 'profiles.approval_status exists');
select table_privs_are('public','allowed_email_domains','anon', array[]::text[], 'anon has no table privileges on allowed_email_domains');

-- ===== Seed =====
select is(
  (select count(*)::int from public.allowed_email_domains
   where domain in ('goabroad.com', 'adelanteabroad.com')),
  2,
  'both domains are seeded');

-- Case-insensitive uniqueness
select throws_ok(
  $$insert into public.allowed_email_domains (domain) values ('GoAbroad.com')$$,
  '23505',
  null,
  'a domain cannot be listed twice in different cases');

-- ===== is_email_domain_allowed =====
select ok(public.is_email_domain_allowed('alice@goabroad.com'), 'listed domain is allowed');
select ok(public.is_email_domain_allowed('  Alice@GoAbroad.COM '), 'normalises case and whitespace');
select ok(not public.is_email_domain_allowed('eve@evil.com'), 'unlisted domain is refused');
select ok(not public.is_email_domain_allowed('a@mail.goabroad.com'),
  'a subdomain does not inherit its parent listing');
select ok(not public.is_email_domain_allowed('not-an-email'), 'malformed address is refused, not an error');
select ok(not public.is_email_domain_allowed(null), 'null is refused, not an error');

-- The domain list is a secret and this function answers questions about it.
-- If PostgREST can reach it with the anon or authenticated key, anyone can
-- enumerate the allowlist by probing candidate domains. These three assertions
-- are the guard on that: a future migration that re-grants execute fails here
-- rather than leaking silently in production.
select function_privs_are('public', 'is_email_domain_allowed', ARRAY['text'],
  'anon', ARRAY[]::text[], 'anon cannot execute is_email_domain_allowed');
select function_privs_are('public', 'is_email_domain_allowed', ARRAY['text'],
  'authenticated', ARRAY[]::text[], 'authenticated cannot execute is_email_domain_allowed');
select function_privs_are('public', 'is_email_domain_allowed', ARRAY['text'],
  'service_role', ARRAY['EXECUTE'], 'service_role can execute is_email_domain_allowed');

-- ===== handle_new_user =====
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values ('22222222-2222-2222-2222-222222222222',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'bob@goabroad.com',
        '{"first_name":"Bob","last_name":"Reyes"}'::jsonb, now(), now());

select is(
  (select full_name from public.profiles where id = '22222222-2222-2222-2222-222222222222'),
  'Bob Reyes',
  'full_name is composed from first and last name');

select is(
  (select approval_status from public.profiles where id = '22222222-2222-2222-2222-222222222222'),
  'pending',
  'a new account starts pending');

-- An OAuth signup carries full_name and no split name
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values ('33333333-3333-3333-3333-333333333333',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'carol@goabroad.com',
        '{"full_name":"Carol Tan","avatar_url":"https://x/y.png"}'::jsonb, now(), now());

select is(
  (select full_name from public.profiles where id = '33333333-3333-3333-3333-333333333333'),
  'Carol Tan',
  'an OAuth signup keeps the full_name it supplies');

select throws_ok(
  $$insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values ('44444444-4444-4444-4444-444444444444',
            '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'eve@evil.com', '{}'::jsonb, now(), now())$$,
  'P0001',
  'This email address is not eligible to register',
  'an unlisted domain cannot create an account at all');

select * from finish();
rollback;
