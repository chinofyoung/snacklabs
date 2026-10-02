# Email/Password Auth with Admin Confirmation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person register with first name, last name, email and password; allow it only for email domains an admin has listed; and require an admin to confirm the account before it can do anything.

**Architecture:** The allowed-domain list lives in an admin-only Postgres table that the browser can never read. A `register` Edge Function running under the service role is the front door — it checks the domain and returns a uniform generic error for anything ineligible. The `handle_new_user` trigger independently re-checks the domain as a backstop, because `supabase.auth.signUp()` stays reachable with the public anon key and Google OAuth bypasses the function entirely. Every new account lands `pending`; a new `is_active_user()` predicate gates the RLS policies that are currently open to any authenticated session.

**Tech Stack:** Supabase (Postgres + RLS + Deno Edge Functions), React 19, react-router 8, Tailwind 4, Vite 8, vitest, pgTAP.

**Spec:** `docs/superpowers/specs/2026-10-01-email-password-auth-design.md`

## Global Constraints

- **Never run state-changing git commands.** The repo owner's standing rule. Each task ends with verification, not a commit. Suggested commit commands are provided for the owner to run; do not execute them.
- **Domains are stored bare and lowercased:** `goabroad.com`, never `@goabroad.com` or `GoAbroad.com`.
- **The generic registration error is exactly:** `This email address can't be used to register. Check with your administrator.` Used verbatim for both a disallowed domain and an already-registered email.
- **Password minimum is 6 characters** — `minimum_password_length = 6` in `supabase/config.toml`. Do not hardcode a different number.
- **`full_name` stays the single display field.** Do not replace reads of `full_name` anywhere in the app.
- **Existing users must not be disrupted.** Any migration that could set a current user to `pending` is a defect.
- New migration files are additive and go in `supabase/migrations/`. Never edit an existing migration.

## Review Focus

These are implied by the spec but easy to leave untested. Each has a test assigned to the task that owns the code.

1. **Subdomain must not match a listed domain** — `a@mail.goabroad.com` with `goabroad.com` listed must be refused, or the allowlist silently covers every subdomain an attacker controls. *(Task 1 + Task 2)*
2. **A pending session hitting PostgREST directly** — a valid JWT with `approval_status = 'pending'` must read nothing but its own profile row, regardless of what the UI does. *(Task 3)*
3. **Malformed emails must not crash the domain check** — no `@`, trailing `@`, multiple `@`, empty string. *(Task 1)*
4. **Already-registered email must return the generic error, not a 500 or a distinct message** — a distinct response is an enumeration oracle revealing that the address's domain is allowed. *(Task 4)*
5. **An admin typing a full email into the domain box** — `portia@adelanteabroad.com` must be rejected with guidance, not stored as a domain that can never match. *(Task 1 + Task 7)*

---

## File Structure

**Create:**
- `src/lib/emailDomain.ts` — pure domain normalisation and validation; no imports
- `src/lib/emailDomain.test.ts` — vitest
- `supabase/migrations/20261002000000_allowed_email_domains.sql` — table, profile columns, trigger rewrite, seed, teardown of the old allowlist
- `supabase/migrations/20261002000100_approval_gating.sql` — `is_active_user()`, RLS tightening, admin RPCs
- `supabase/tests/allowed_email_domains.test.sql` — pgTAP
- `supabase/tests/approval_gating.test.sql` — pgTAP
- `supabase/functions/register/index.ts` — service-role registration endpoint
- `src/pages/Register.tsx` — registration form
- `src/components/AccountStatus.tsx` — pending / rejected screens

**Modify:**
- `src/types.ts` — `AllowedDomain`, `ApprovalStatus`, extend `Profile` shape
- `src/context/AuthContext.tsx` — carry approval fields
- `src/components/guards.tsx` — route on approval status
- `src/pages/Login.tsx` — email/password form above the Google button
- `src/App.tsx` — `/register` route
- `src/pages/admin/Users.tsx` — pending queue, allowed domains, revoke access

---

### Task 1: Pure email/domain rules

The Edge Function and the admin UI must agree on what a domain is. This is the only piece that can be tested without a database, so it goes first and everything else imports it.

**Files:**
- Create: `src/lib/emailDomain.ts`
- Test: `src/lib/emailDomain.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `normalizeEmail(raw: string): string`
  - `emailDomain(raw: string): string | null` — null when the address is malformed
  - `normalizeDomain(raw: string): string`
  - `isValidDomain(raw: string): boolean`

- [ ] **Step 1: Write the failing test**

Create `src/lib/emailDomain.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { normalizeEmail, emailDomain, normalizeDomain, isValidDomain } from './emailDomain'

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Alice@GoAbroad.com ')).toBe('alice@goabroad.com')
  })
})

describe('emailDomain', () => {
  it('extracts the domain', () => {
    expect(emailDomain('alice@goabroad.com')).toBe('goabroad.com')
  })
  it('normalizes before extracting', () => {
    expect(emailDomain(' Alice@GoAbroad.COM ')).toBe('goabroad.com')
  })
  it('keeps a subdomain distinct from its parent', () => {
    // Must NOT collapse to goabroad.com: listing a domain must not
    // silently authorise every subdomain under it.
    expect(emailDomain('a@mail.goabroad.com')).toBe('mail.goabroad.com')
  })
  it('returns null when there is no @', () => {
    expect(emailDomain('alice.goabroad.com')).toBeNull()
  })
  it('returns null on a trailing @', () => {
    expect(emailDomain('alice@')).toBeNull()
  })
  it('returns null on a leading @', () => {
    expect(emailDomain('@goabroad.com')).toBeNull()
  })
  it('returns null when there are two @', () => {
    expect(emailDomain('a@b@goabroad.com')).toBeNull()
  })
  it('returns null on an empty string', () => {
    expect(emailDomain('')).toBeNull()
  })
  it('returns null when the domain has no dot', () => {
    expect(emailDomain('alice@localhost')).toBeNull()
  })
})

describe('normalizeDomain', () => {
  it('lowercases and trims', () => {
    expect(normalizeDomain('  GoAbroad.com ')).toBe('goabroad.com')
  })
  it('strips a leading @ an admin may type', () => {
    expect(normalizeDomain('@goabroad.com')).toBe('goabroad.com')
  })
})

describe('isValidDomain', () => {
  it('accepts a plain domain', () => {
    expect(isValidDomain('goabroad.com')).toBe(true)
  })
  it('accepts a subdomain', () => {
    expect(isValidDomain('mail.goabroad.com')).toBe(true)
  })
  it('rejects a full email address', () => {
    // An admin pasting portia@adelanteabroad.com must be told, not left
    // with a row that can never match anything.
    expect(isValidDomain('portia@adelanteabroad.com')).toBe(false)
  })
  it('rejects a bare label with no dot', () => {
    expect(isValidDomain('goabroad')).toBe(false)
  })
  it('rejects an empty string', () => {
    expect(isValidDomain('')).toBe(false)
  })
  it('rejects whitespace inside', () => {
    expect(isValidDomain('go abroad.com')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- emailDomain`
Expected: FAIL — `Failed to resolve import "./emailDomain"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/emailDomain.ts`:

```ts
// Shared email/domain rules. Deliberately pure and dependency-free: the
// registration Edge Function, the admin domain form and the pgTAP suite must
// all agree on what counts as a domain, and that agreement is only worth
// anything if it can be tested without a database.

/** Lowercase and trim. Email domains are case-insensitive. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

/**
 * The domain part of an email address, or null if the address is malformed.
 *
 * Returns the FULL domain, so `a@mail.goabroad.com` yields `mail.goabroad.com`
 * and does not match a `goabroad.com` entry. Collapsing to a registrable
 * suffix would mean listing one domain authorised every subdomain under it,
 * including any an attacker happens to control.
 */
export function emailDomain(raw: string): string | null {
  const email = normalizeEmail(raw)
  const parts = email.split('@')
  if (parts.length !== 2) return null
  const [local, domain] = parts
  if (!local || !domain) return null
  return isValidDomain(domain) ? domain : null
}

/** Lowercase, trim, and forgive a leading `@` an admin may type out of habit. */
export function normalizeDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/^@/, '')
}

/**
 * A plausible domain: at least two dot-separated labels, no `@`, no
 * whitespace. Not a full DNS validation — just enough to reject the two
 * mistakes that actually happen, a pasted email address and a bare label.
 */
export function isValidDomain(raw: string): boolean {
  const domain = normalizeDomain(raw)
  if (!domain || domain.includes('@') || /\s/.test(domain)) return false
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- emailDomain`
Expected: PASS, all cases.

- [ ] **Step 5: Verify nothing else broke**

Run: `npm test && npx tsc -b`
Expected: all suites pass, no type errors.

- [ ] **Step 6: Hand off**

Do **not** commit. Report the files changed. Suggested command for the repo owner:

```bash
git add src/lib/emailDomain.ts src/lib/emailDomain.test.ts && git commit -m "feat: add pure email domain rules"
```

---

### Task 2: Domain allowlist schema and registration gate

**Files:**
- Create: `supabase/migrations/20261002000000_allowed_email_domains.sql`
- Create: `supabase/tests/allowed_email_domains.test.sql`

**Interfaces:**
- Consumes: nothing
- Produces:
  - table `public.allowed_email_domains (id uuid, domain text, note text, created_at timestamptz)`
  - `public.is_email_domain_allowed(p_email text) returns boolean`
  - `public.profiles.first_name`, `.last_name`, `.approval_status`, `.approved_by`, `.approved_at`
  - `public.handle_new_user()` rewritten
  - `public.email_allowlist` and `public.set_email_access` dropped

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/allowed_email_domains.test.sql`:

```sql
create extension if not exists pgtap with schema extensions;
begin;
select plan(17);

-- ===== Shape =====
select has_table('public', 'allowed_email_domains', 'allowed_email_domains table exists');
select hasnt_table('public', 'email_allowlist', 'the per-address allowlist is gone');
select has_column('public', 'profiles', 'first_name', 'profiles.first_name exists');
select has_column('public', 'profiles', 'last_name', 'profiles.last_name exists');
select has_column('public', 'profiles', 'approval_status', 'profiles.approval_status exists');

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx supabase test db`
Expected: FAIL — `relation "public.allowed_email_domains" does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20261002000000_allowed_email_domains.sql`:

```sql
-- Replaces the hardcoded @goabroad.com rule and the per-address
-- email_allowlist with an admin-managed list of allowed email DOMAINS, and
-- makes every new account start pending until an admin confirms it.
--
-- The domain list is a secret: users are never told which domains are
-- allowed, so this table is admin-only for READ as well as write, and the
-- eligibility check runs in a security-definer function rather than
-- anywhere the browser can reach.

-- ===== allowed_email_domains =====
create table public.allowed_email_domains (
  id uuid primary key default gen_random_uuid(),
  domain text not null,
  note text not null default '',
  created_at timestamptz not null default now()
);

alter table public.allowed_email_domains enable row level security;

create policy "allowed_email_domains admin all" on public.allowed_email_domains
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Case-insensitive uniqueness: "GoAbroad.com" and "goabroad.com" are the same
-- domain, and two rows would make removal look like it had failed.
create unique index allowed_email_domains_domain_lower_idx
  on public.allowed_email_domains (lower(domain));

-- Seed: goabroad.com was hardcoded in handle_new_user, and adelanteabroad.com
-- is the domain of the single row that existed in email_allowlist. Seeding
-- both means no one who can sign in today loses access.
insert into public.allowed_email_domains (domain, note) values
  ('goabroad.com', 'Primary company domain'),
  ('adelanteabroad.com', 'Partner domain')
on conflict do nothing;

-- ===== is_email_domain_allowed =====
-- Mirrors src/lib/emailDomain.ts. Returns the FULL domain comparison, so
-- a@mail.goabroad.com does NOT match a goabroad.com entry: one listing must
-- never authorise every subdomain beneath it.
create or replace function public.is_email_domain_allowed(p_email text)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare
  v_email text;
  v_domain text;
begin
  if p_email is null then
    return false;
  end if;

  v_email := lower(trim(p_email));

  -- Exactly one @, with something on each side.
  if array_length(string_to_array(v_email, '@'), 1) <> 2 then
    return false;
  end if;

  v_domain := split_part(v_email, '@', 2);
  if split_part(v_email, '@', 1) = '' or v_domain = '' or v_domain not like '%.%' then
    return false;
  end if;

  return exists (
    select 1 from public.allowed_email_domains where lower(domain) = v_domain
  );
end;
$$;

-- ===== profiles: names and approval =====
alter table public.profiles
  add column first_name text not null default '',
  add column last_name  text not null default '',
  add column approved_by uuid references public.profiles(id),
  add column approved_at timestamptz;

-- Two steps, and the order matters. Adding the column with default 'approved'
-- backfills every EXISTING row as approved, so no current user is locked out.
-- Only then does the default flip to 'pending' for accounts created from here on.
alter table public.profiles
  add column approval_status text not null default 'approved'
    check (approval_status in ('pending', 'approved', 'rejected'));

alter table public.profiles
  alter column approval_status set default 'pending';

create index profiles_approval_status_idx on public.profiles (approval_status)
  where approval_status = 'pending';

-- ===== handle_new_user =====
-- Serves two sign-up paths with different metadata shapes:
--   email/password (via the register Edge Function) sends first_name/last_name
--   Google OAuth sends full_name/avatar_url and no split name
-- full_name stays the single display field the rest of the app reads. A name
-- is NOT split on whitespace for OAuth users: names do not reliably divide
-- that way, and a wrong split is worse than an empty field.
--
-- This re-checks the domain even though the Edge Function already did:
-- supabase.auth.signUp() remains reachable with the public anon key, and
-- Google OAuth never passes through the function at all.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_first text := coalesce(new.raw_user_meta_data->>'first_name', '');
  v_last  text := coalesce(new.raw_user_meta_data->>'last_name', '');
  v_full  text;
begin
  if not public.is_email_domain_allowed(new.email) then
    raise exception 'This email address is not eligible to register';
  end if;

  v_full := nullif(trim(v_first || ' ' || v_last), '');
  if v_full is null then
    v_full := coalesce(new.raw_user_meta_data->>'full_name', '');
  end if;

  insert into public.profiles (id, email, first_name, last_name, full_name, avatar_url)
  values (new.id, new.email, v_first, v_last, v_full,
          new.raw_user_meta_data->>'avatar_url');

  insert into public.wallets (user_id) values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

-- ===== Teardown of the per-address allowlist =====
-- set_email_access was also the only way to set is_blocked; that capability
-- moves to set_user_access in 20261002000100_approval_gating.sql.
drop function if exists public.set_email_access(text, boolean, text);
drop table if exists public.email_allowlist;

-- ===== Grants =====
grant select, insert, update, delete on public.allowed_email_domains to authenticated;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx supabase test db`
Expected: PASS — 16 of 16 in `allowed_email_domains.test.sql`. The wallet suites must also still pass.

- [ ] **Step 5: Confirm no existing user was set to pending**

Run:

```bash
npx supabase db reset && npx supabase test db
```

Expected: a clean reset applies every migration in order with no error. Then, against a database that had rows before the migration, confirm manually in Studio that existing profiles read `approved`.

- [ ] **Step 6: Hand off**

Do **not** commit. Suggested command for the repo owner:

```bash
git add supabase/migrations/20261002000000_allowed_email_domains.sql supabase/tests/allowed_email_domains.test.sql && git commit -m "feat: add allowed email domain list and pending accounts"
```

---

### Task 3: Access gating and admin RPCs

Closes the hole where a pending session — which is `authenticated` and holds a valid JWT — can read the whole user list, catalogue and payment methods through PostgREST.

**Files:**
- Create: `supabase/migrations/20261002000100_approval_gating.sql`
- Create: `supabase/tests/approval_gating.test.sql`

**Interfaces:**
- Consumes: `profiles.approval_status`, `profiles.is_blocked` (Task 2)
- Produces:
  - `public.is_active_user() returns boolean`
  - `public.set_registration_status(p_user_id uuid, p_status text) returns text`
  - `public.set_user_access(p_user_id uuid, p_allowed boolean) returns text`

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/approval_gating.test.sql`:

```sql
create extension if not exists pgtap with schema extensions;
begin;
select plan(17);

select has_function('public', 'is_active_user', 'is_active_user exists');
select has_function('public', 'set_registration_status', ARRAY['uuid','text'], 'set_registration_status exists');
select has_function('public', 'set_user_access', ARRAY['uuid','boolean'], 'set_user_access exists');

-- Three users: an admin, a pending registrant, an approved shopper.
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
   '{"first_name":"Sam","last_name":"Shopper"}'::jsonb, now(), now());

update public.profiles set is_admin = true, approval_status = 'approved'
  where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
update public.profiles set approval_status = 'approved'
  where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

insert into public.items (id, name, price, stock)
values ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'Biscuit', 25, 10);

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

select throws_ok(
  $$select public.create_order(
      '[{"item_id":"dddddddd-dddd-dddd-dddd-dddddddddddd","qty":1}]'::jsonb, null)$$,
  'P0001',
  'account not approved',
  'a pending user cannot place an order');

-- ===== An approved session is unaffected =====
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc"}';
select is((select count(*)::int from public.items), 1, 'an approved user reads items');

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

reset role;

select * from finish();
rollback;
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx supabase test db`
Expected: FAIL — `function public.is_active_user() does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20261002000100_approval_gating.sql`:

```sql
-- A registered-but-unconfirmed account holds a valid JWT and is
-- `authenticated`, so the policies written as `using (true)` would hand it the
-- entire user list, catalogue and payment methods while it waits. This file
-- narrows those policies to approved accounts and adds the two admin actions
-- the /admin/users page needs.

-- ===== is_active_user =====
create or replace function public.is_active_user()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((
    select approval_status = 'approved' and not is_blocked
    from public.profiles where id = auth.uid()
  ), false)
$$;

-- ===== Narrow the open read policies =====
drop policy if exists "profiles read all" on public.profiles;
-- Own row stays readable unconditionally: AuthContext and the pending screen
-- both need it, and without it a pending user cannot even be told they are pending.
create policy "profiles read self" on public.profiles for select to authenticated
  using (id = auth.uid());
create policy "profiles read active or admin" on public.profiles for select to authenticated
  using (public.is_active_user() or public.is_admin());

drop policy if exists "items read" on public.items;
create policy "items read active" on public.items for select to authenticated
  using (public.is_active_user() or public.is_admin());

drop policy if exists "pm read" on public.payment_methods;
create policy "pm read active" on public.payment_methods for select to authenticated
  using (public.is_active_user() or public.is_admin());

drop policy if exists "wallets read own or admin" on public.wallets;
create policy "wallets read own or admin" on public.wallets for select to authenticated
  using ((user_id = auth.uid() and public.is_active_user()) or public.is_admin());

drop policy if exists "wallet_entries read own or admin" on public.wallet_entries;
create policy "wallet_entries read own or admin" on public.wallet_entries for select to authenticated
  using ((user_id = auth.uid() and public.is_active_user()) or public.is_admin());

drop policy if exists "topup_requests read own or admin" on public.topup_requests;
create policy "topup_requests read own or admin" on public.topup_requests for select to authenticated
  using ((user_id = auth.uid() and public.is_active_user()) or public.is_admin());

-- ===== create_order: refuse unapproved accounts =====
-- Identical to the version in 20260908120000_email_allowlist.sql apart from the
-- added approval check; repeated in full because create or replace needs the
-- whole body.
create or replace function public.create_order(p_items jsonb, p_payment_method_id uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_order_id uuid;
  v_total numeric(10,2) := 0;
  r record;
  v_price numeric(10,2);
  v_stock integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not public.is_active_user() then
    if (select is_blocked from public.profiles where id = auth.uid()) then
      raise exception 'access revoked';
    end if;
    raise exception 'account not approved';
  end if;
  if jsonb_array_length(p_items) = 0 then
    raise exception 'empty order';
  end if;

  insert into public.orders (user_id, total, status, payment_method_id)
  values (auth.uid(), 0, 'awaiting_payment', p_payment_method_id)
  returning id into v_order_id;

  for r in
    select (e->>'item_id')::uuid as item_id, (e->>'qty')::int as qty
    from jsonb_array_elements(p_items) e
  loop
    if r.qty is null or r.qty <= 0 then
      raise exception 'invalid quantity';
    end if;
    select price, stock into v_price, v_stock
    from public.items where id = r.item_id and is_active for update;
    if not found then
      raise exception 'item % not found', r.item_id;
    end if;
    if v_stock < r.qty then
      raise exception 'insufficient stock: %', r.item_id;
    end if;
    insert into public.order_items (order_id, item_id, qty, price_at_purchase)
    values (v_order_id, r.item_id, r.qty, v_price);
    v_total := v_total + v_price * r.qty;
  end loop;

  update public.orders set total = v_total where id = v_order_id;
  return v_order_id;
end;
$$;

-- ===== set_registration_status (admin only) =====
create or replace function public.set_registration_status(p_user_id uuid, p_status text)
returns text
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden';
  end if;
  if p_status not in ('approved', 'rejected') then
    raise exception 'invalid status';
  end if;

  update public.profiles
     set approval_status = p_status,
         approved_by = auth.uid(),
         approved_at = now()
   where id = p_user_id;

  if not found then
    raise exception 'user not found';
  end if;

  return p_status;
end;
$$;

-- ===== set_user_access (admin only) =====
-- Replaces the blocking half of the dropped set_email_access. Takes a user id
-- rather than an email: with the per-address allowlist gone, revocation is a
-- property of an account, not of a string.
create or replace function public.set_user_access(p_user_id uuid, p_allowed boolean)
returns text
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden';
  end if;

  if not p_allowed and exists (
    select 1 from public.profiles where id = p_user_id and is_admin
  ) then
    raise exception 'cannot revoke access for an admin';
  end if;

  update public.profiles set is_blocked = not p_allowed where id = p_user_id;

  if not found then
    raise exception 'user not found';
  end if;

  return case when p_allowed then 'restored' else 'revoked' end;
end;
$$;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx supabase test db`
Expected: PASS — 14 of 14 in `approval_gating.test.sql`, and every pre-existing wallet suite still green.

- [ ] **Step 5: Hand off**

Do **not** commit. Suggested command for the repo owner:

```bash
git add supabase/migrations/20261002000100_approval_gating.sql supabase/tests/approval_gating.test.sql && git commit -m "feat: gate app access on admin approval"
```

---

### Task 4: `register` Edge Function

**Files:**
- Create: `supabase/functions/register/index.ts`

**Interfaces:**
- Consumes: `public.allowed_email_domains` (Task 2)
- Produces: `POST /functions/v1/register` taking `{first_name, last_name, email, password}` and returning `{ok: true}` on 200, or `{error: string}` on 400/403/500.

- [ ] **Step 1: Write the function**

Create `supabase/functions/register/index.ts`:

```ts
import { createClient } from 'npm:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// One message for every outcome that could distinguish an allowed domain from a
// disallowed one. "Domain not allowed" and "already registered" MUST read
// identically: a distinct second message would let anyone probe addresses and
// learn, from the difference, which domains are on the list.
const GENERIC = "This email address can't be used to register. Check with your administrator."

// Matches minimum_password_length in supabase/config.toml.
const MIN_PASSWORD = 6

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  const body = await req.json().catch(() => null)
  if (!body) return json({ error: 'invalid request' }, 400)

  const firstName = String(body.first_name ?? '').trim()
  const lastName = String(body.last_name ?? '').trim()
  const email = String(body.email ?? '').trim().toLowerCase()
  const password = String(body.password ?? '')

  // Shape errors are reported precisely: they say nothing about the domain list.
  if (!firstName) return json({ error: 'First name is required.' }, 400)
  if (!lastName) return json({ error: 'Last name is required.' }, 400)
  if (!email) return json({ error: 'Email is required.' }, 400)
  if (password.length < MIN_PASSWORD) {
    return json({ error: `Password must be at least ${MIN_PASSWORD} characters.` }, 400)
  }

  // Service role: the domain list is admin-only by RLS, and deliberately
  // unreadable by the browser. The check can only happen here.
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )

  const { data: allowed, error: checkErr } = await admin.rpc('is_email_domain_allowed', {
    p_email: email,
  })

  // A failed check is an outage, not a verdict. Returning GENERIC here would
  // tell a legitimate user they are ineligible because the database hiccuped.
  if (checkErr) {
    console.error('register: domain check failed', checkErr)
    return json({ error: 'Something went wrong. Please try again.' }, 500)
  }

  if (!allowed) {
    console.warn('register: refused ineligible domain for', email)
    return json({ error: GENERIC }, 403)
  }

  // email_confirm: true marks the address confirmed without sending mail.
  // Admin confirmation is the gate, and no SMTP provider is configured.
  const { error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { first_name: firstName, last_name: lastName },
  })

  if (createErr) {
    // Covers "already registered" and the trigger's own domain refusal. Both
    // collapse into GENERIC on purpose; the real reason goes to the logs only.
    console.warn('register: createUser failed for', email, createErr.message)
    return json({ error: GENERIC }, 403)
  }

  return json({ ok: true }, 200)
})

function json(payload: unknown, status: number) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}
```

- [ ] **Step 2: Serve the function locally**

Run: `npx supabase functions serve register --no-verify-jwt`
Expected: the function starts and reports it is listening. `--no-verify-jwt` is required — a person registering has no JWT yet.

- [ ] **Step 3: Verify an allowed domain succeeds**

Run (in a second shell, substituting the local anon key from `npx supabase status`):

```bash
curl -s -i -X POST http://127.0.0.1:54321/functions/v1/register \
  -H "Content-Type: application/json" \
  -H "apikey: <LOCAL_ANON_KEY>" \
  -d '{"first_name":"Test","last_name":"User","email":"test.user@goabroad.com","password":"hunter2"}'
```

Expected: `HTTP/1.1 200` and `{"ok":true}`.

- [ ] **Step 4: Verify a disallowed domain and a duplicate return the identical body**

Run both:

```bash
curl -s -X POST http://127.0.0.1:54321/functions/v1/register \
  -H "Content-Type: application/json" -H "apikey: <LOCAL_ANON_KEY>" \
  -d '{"first_name":"Eve","last_name":"Attacker","email":"eve@evil.com","password":"hunter2"}'

curl -s -X POST http://127.0.0.1:54321/functions/v1/register \
  -H "Content-Type: application/json" -H "apikey: <LOCAL_ANON_KEY>" \
  -d '{"first_name":"Test","last_name":"User","email":"test.user@goabroad.com","password":"hunter2"}'
```

Expected: **both** return HTTP 403 with a byte-identical body — `{"error":"This email address can't be used to register. Check with your administrator."}`. If the two differ in any way, the enumeration oracle is open and the task is not done.

- [ ] **Step 5: Verify the new account is pending**

Run: `npx supabase db query "select email, first_name, last_name, full_name, approval_status from public.profiles where email = 'test.user@goabroad.com'"`
Expected: one row, `full_name` = `Test User`, `approval_status` = `pending`.

- [ ] **Step 6: Hand off**

Do **not** commit. Suggested command for the repo owner:

```bash
git add supabase/functions/register/index.ts && git commit -m "feat: add register edge function with domain gate"
```

---

### Task 5: Auth state and route guards

**Files:**
- Modify: `src/types.ts`
- Modify: `src/context/AuthContext.tsx`
- Modify: `src/components/guards.tsx`
- Create: `src/components/AccountStatus.tsx`

**Interfaces:**
- Consumes: `profiles.approval_status` (Task 2)
- Produces:
  - `ApprovalStatus = 'pending' | 'approved' | 'rejected'`
  - `AllowedDomain { id, domain, note, created_at }`
  - `Profile` gains `first_name`, `last_name`, `approval_status`
  - `<AccountStatus status={'pending' | 'rejected'} />`

- [ ] **Step 1: Extend the shared types**

In `src/types.ts`, replace the `EmailAllowlistEntry` interface with:

```ts
export type ApprovalStatus = 'pending' | 'approved' | 'rejected'

export interface AllowedDomain {
  id: string
  domain: string
  note: string
  created_at: string
}

export interface PendingRegistration {
  id: string
  email: string
  full_name: string
  first_name: string
  last_name: string
  created_at: string
}
```

- [ ] **Step 2: Extend the Profile shape**

In `src/context/AuthContext.tsx`, change the `Profile` interface to:

```ts
export interface Profile {
  id: string
  email: string
  full_name: string
  first_name: string
  last_name: string
  avatar_url: string | null
  is_admin: boolean
  is_blocked: boolean
  approval_status: ApprovalStatus
}
```

and add the import:

```ts
import type { ApprovalStatus } from '../types'
```

- [ ] **Step 3: Create the status screen**

Create `src/components/AccountStatus.tsx`:

```tsx
import CookieMark from './CookieMark'
import { useAuth } from '../context/AuthContext'

// Shown to a signed-in account that is not approved. Deliberately a full
// screen rather than a toast: there is nothing else this session may do, and
// RLS enforces that regardless of what is rendered here.
export default function AccountStatus({ status }: { status: 'pending' | 'rejected' }) {
  const { signOut } = useAuth()
  const pending = status === 'pending'

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center gap-4 px-6 text-center">
      <CookieMark className="size-12 text-brand-600" />
      <h1 className="font-display text-xl font-bold">
        {pending ? 'Waiting for confirmation' : 'Registration not approved'}
      </h1>
      <p className="text-sm text-ink-500 max-w-xs">
        {pending
          ? 'Your account has been created. An administrator needs to confirm it before you can start shopping.'
          : 'Your registration was not approved. Check with your administrator if you think this is a mistake.'}
      </p>
      <button
        onClick={() => void signOut()}
        className="rounded-2xl bg-surface-raised text-ink-900 px-5 py-3 font-medium shadow-card active:scale-[0.98] transition"
      >
        Sign out
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Route on approval status**

In `src/components/guards.tsx`, add the import:

```tsx
import AccountStatus from './AccountStatus'
```

Replace `RequireAuth` and `HomeRedirect` with:

```tsx
export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, profile, loading, signOut } = useAuth()
  const blocked = !loading && !!session && !!profile?.is_blocked

  useEffect(() => {
    if (blocked) void signOut()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocked])

  if (loading) return <Splash />
  if (!session) return <Navigate to="/login" replace />
  if (blocked) return <Splash />
  // Approval is checked after blocking: a blocked account is signed out
  // outright, which is a harder stop than the status screen.
  if (profile?.approval_status === 'pending') return <AccountStatus status="pending" />
  if (profile?.approval_status === 'rejected') return <AccountStatus status="rejected" />
  return <>{children}</>
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { session, profile, loading } = useAuth()
  if (loading) return <Splash />
  if (!session) return <Navigate to="/login" replace />
  if (!profile?.is_admin) return <Navigate to="/store" replace />
  return <>{children}</>
}

// Landing hub for "/": once auth resolves, sends admins to the admin
// console, unapproved accounts to their status screen, and everyone else
// to the storefront.
export function HomeRedirect() {
  const { session, profile, loading } = useAuth()
  if (loading) return <Splash />
  if (!session) return <Navigate to="/login" replace />
  if (profile?.approval_status === 'pending') return <AccountStatus status="pending" />
  if (profile?.approval_status === 'rejected') return <AccountStatus status="rejected" />
  return <Navigate to={profile?.is_admin ? '/admin' : '/store'} replace />
}
```

- [ ] **Step 5: Verify types and tests**

Run: `npx tsc -b && npm test && npm run lint`
Expected: no type errors, all suites pass, no new lint errors. `src/pages/admin/Users.tsx` will still reference the removed `EmailAllowlistEntry` and fail to compile — that is expected and is fixed in Task 7. If you need a green build before then, proceed to Task 6 and 7 and run this check again at the end of Task 7.

- [ ] **Step 6: Hand off**

Do **not** commit. Suggested command for the repo owner:

```bash
git add src/types.ts src/context/AuthContext.tsx src/components/guards.tsx src/components/AccountStatus.tsx && git commit -m "feat: route on account approval status"
```

---

### Task 6: Registration page and password login

**Files:**
- Create: `src/pages/Register.tsx`
- Modify: `src/pages/Login.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: the `register` Edge Function (Task 4), `emailDomain` helpers (Task 1)
- Produces: route `/register`

- [ ] **Step 1: Create the registration page**

Create `src/pages/Register.tsx`:

```tsx
import { useState } from 'react'
import { Link } from 'react-router'
import { supabase } from '../lib/supabase'

const MIN_PASSWORD = 6

export default function Register() {
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (!firstName.trim() || !lastName.trim()) {
      setError('First and last name are required.')
      return
    }
    if (password.length < MIN_PASSWORD) {
      setError(`Password must be at least ${MIN_PASSWORD} characters.`)
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }

    setBusy(true)
    // Goes through the Edge Function, never supabase.auth.signUp: the domain
    // list is admin-only by RLS and cannot be checked from the browser.
    const { data, error: fnErr } = await supabase.functions.invoke('register', {
      body: {
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        email: email.trim().toLowerCase(),
        password,
      },
    })

    if (fnErr) {
      // invoke() surfaces any non-2xx as an error; the body carries the message.
      let message = 'Something went wrong. Please try again.'
      try {
        const ctx = (fnErr as { context?: Response }).context
        if (ctx) {
          const parsed = await ctx.clone().json()
          if (parsed?.error) message = parsed.error
        }
      } catch { /* fall through to the generic message */ }
      setError(message)
      setBusy(false)
      return
    }

    if (data && typeof data === 'object' && 'error' in data) {
      setError(String((data as { error: string }).error))
      setBusy(false)
      return
    }

    setDone(true)
    setBusy(false)
  }

  if (done) {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center gap-4 px-6 text-center bg-ink-900">
        <div className="rounded-2xl bg-logo-cream px-8 py-7 max-w-xs space-y-2">
          <h1 className="font-display text-xl font-bold text-ink-900">Registration received</h1>
          <p className="text-sm text-ink-500">
            An administrator needs to confirm your account before you can sign in.
          </p>
          <Link to="/login" className="block pt-2 text-sm font-medium text-brand-700 underline underline-offset-2">
            Back to sign in
          </Link>
        </div>
      </div>
    )
  }

  const field = 'w-full rounded-xl bg-surface-raised border border-line px-3 py-3 text-sm outline-none focus-visible:outline-2 focus-visible:outline-brand-700'

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-6 py-10 bg-ink-900">
      <div className="w-full max-w-xs">
        <div className="rounded-2xl bg-logo-cream px-8 pt-8 pb-7 text-center shadow-float">
          <img src="/assets/snacklabs-logo.png" alt="SnackLabs" width={1182} height={372} className="w-56 h-auto mx-auto" />
          <p className="text-ink-500 mt-1 text-sm">Create your account.</p>
        </div>

        <form onSubmit={submit} className="mt-8 space-y-3">
          <div className="flex gap-2">
            <input className={field} placeholder="First name" value={firstName}
              onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" required />
            <input className={field} placeholder="Last name" value={lastName}
              onChange={(e) => setLastName(e.target.value)} autoComplete="family-name" required />
          </div>
          <input className={field} type="email" placeholder="Email address" value={email}
            onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
          <input className={field} type="password" placeholder="Password" value={password}
            onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
          <input className={field} type="password" placeholder="Confirm password" value={confirm}
            onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />

          {error && <p className="text-sm text-red-400" role="alert">{error}</p>}

          <button type="submit" disabled={busy}
            className="w-full rounded-2xl bg-brand-600 text-white py-3.5 font-semibold shadow-card active:scale-[0.98] transition disabled:opacity-50">
            {busy ? 'Creating account…' : 'Create account'}
          </button>
        </form>

        <p className="text-xs text-center text-ink-400 mt-5">
          Already have an account?{' '}
          <Link to="/login" className="underline underline-offset-2 hover:text-white transition-colors">Sign in</Link>
        </p>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Add the password form to the login page**

In `src/pages/Login.tsx`, add at the top:

```tsx
import { useState } from 'react'
```

and change the component's opening so the existing `signIn` is joined by password sign-in:

```tsx
export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const signIn = () =>
    supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    })

  const signInWithPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error: authErr } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    })
    if (authErr) {
      // Supabase returns the same "Invalid login credentials" for a wrong
      // password and an unknown address, which is the behaviour we want.
      setError('Incorrect email or password.')
      setBusy(false)
      return
    }
    // On success the auth listener in AuthContext takes over and the guards
    // route to the store, the admin console, or the pending screen.
    setBusy(false)
  }

  const field = 'w-full rounded-xl bg-surface-raised border border-line px-3 py-3 text-sm outline-none focus-visible:outline-2 focus-visible:outline-brand-700'
```

Then, inside `<div className="mt-10 space-y-4">`, insert **above** the existing Google button:

```tsx
          <form onSubmit={signInWithPassword} className="space-y-3">
            <input className={field} type="email" placeholder="Email address" value={email}
              onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
            <input className={field} type="password" placeholder="Password" value={password}
              onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
            {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
            <button type="submit" disabled={busy}
              className="w-full rounded-2xl bg-brand-600 text-white py-3.5 font-semibold shadow-card active:scale-[0.98] transition disabled:opacity-50">
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <div className="flex items-center gap-3" aria-hidden>
            <span className="h-px grow bg-white/15" />
            <span className="text-xs text-ink-400">or</span>
            <span className="h-px grow bg-white/15" />
          </div>
```

Finally, replace the existing eligibility line:

```tsx
          <p className="text-xs text-center text-ink-400">goabroad.com accounts or invited emails only</p>
```

with a link to registration that names no domain:

```tsx
          <p className="text-xs text-center text-ink-400">
            No account?{' '}
            <Link to="/register" className="underline underline-offset-2 hover:text-white transition-colors">
              Register
            </Link>
          </p>
```

The old copy named `goabroad.com` on a public, unauthenticated page. Removing it is required by the non-disclosure goal, not a cosmetic change.

- [ ] **Step 3: Add the route**

In `src/App.tsx`, add the import:

```tsx
import Register from './pages/Register'
```

and the route, directly after the `/login` route:

```tsx
      <Route path="/register" element={<Register />} />
```

- [ ] **Step 4: Verify in the running app**

Run: `npm run dev` with `npx supabase start` and `npx supabase functions serve register --no-verify-jwt` running.

Check, in the browser:
1. `/login` shows the email/password form, an "or" divider, the Google button, and a Register link — and **no domain is named anywhere on the page**.
2. `/register` with an allowed domain shows "Registration received".
3. `/register` with `eve@evil.com` shows the generic error and names no domain.
4. Signing in as the newly registered user lands on the "Waiting for confirmation" screen, not the store.

- [ ] **Step 5: Verify the build**

Run: `npx tsc -b && npm run lint`
Expected: no type errors other than the known `EmailAllowlistEntry` reference in `src/pages/admin/Users.tsx`, which Task 7 removes.

- [ ] **Step 6: Hand off**

Do **not** commit. Suggested command for the repo owner:

```bash
git add src/pages/Register.tsx src/pages/Login.tsx src/App.tsx && git commit -m "feat: add registration page and password sign-in"
```

---

### Task 7: Admin pending queue, allowed domains, and access revocation

**Files:**
- Modify: `src/pages/admin/Users.tsx`

**Interfaces:**
- Consumes: `set_registration_status`, `set_user_access` (Task 3); `allowed_email_domains` (Task 2); `AllowedDomain`, `PendingRegistration` (Task 5); `normalizeDomain`, `isValidDomain` (Task 1)
- Produces: nothing downstream

- [ ] **Step 1: Swap the imports**

In `src/pages/admin/Users.tsx`, replace:

```tsx
import type { EmailAllowlistEntry } from '../../types'
```

with:

```tsx
import type { AllowedDomain, PendingRegistration } from '../../types'
import { normalizeDomain, isValidDomain } from '../../lib/emailDomain'
```

and add `Globe`, `UserPlus` and `Ban` to the existing `lucide-react` import.

- [ ] **Step 2: Keep pending rows out of the main user list**

A pending registration would otherwise appear both in the queue and in the list
below it. In `load()`, add `is_blocked` to the select (the revoke control in Step 6
needs it) and exclude pending rows:

```tsx
  const load = () =>
    supabase.from('profiles')
      .select('id, email, full_name, is_admin, is_blocked, created_at')
      .neq('approval_status', 'pending')
      .order('created_at')
      .then(({ data, error: fetchErr }) => {
        if (fetchErr) {
          setError(fetchErr.message)
          return
        }
        setError(null)
        setUsers((data as UserRow[]) ?? [])
      })
```

and extend the `UserRow` interface at the top of the file:

```tsx
interface UserRow {
  id: string
  email: string
  full_name: string
  is_admin: boolean
  is_blocked: boolean
  created_at: string
}
```

- [ ] **Step 3: Load pending registrations**

Add alongside `load()`:

```tsx
  const [pending, setPending] = useState<PendingRegistration[]>([])
  const [pendingBusyId, setPendingBusyId] = useState<string | null>(null)

  const loadPending = () =>
    supabase.from('profiles')
      .select('id, email, full_name, first_name, last_name, created_at')
      .eq('approval_status', 'pending')
      .order('created_at')
      .then(({ data, error: fetchErr }) => {
        if (fetchErr) {
          setError(fetchErr.message)
          return
        }
        setPending((data as PendingRegistration[]) ?? [])
      })

  useEffect(() => { loadPending() }, [])

  const decide = async (row: PendingRegistration, status: 'approved' | 'rejected') => {
    setPendingBusyId(row.id)
    setError(null)
    const { error: rpcErr } = await supabase.rpc('set_registration_status', {
      p_user_id: row.id,
      p_status: status,
    })
    if (rpcErr) {
      setError(rpcErr.message)
      setPendingBusyId(null)
      return
    }
    // Both lists change: an approved registrant becomes a listed user.
    await Promise.all([loadPending(), load()])
    setPendingBusyId(null)
  }
```

- [ ] **Step 4: Replace the allowlist state with domain state**

Replace the `allowlist`, `newEmail`, `newNote`, `pendingRemove` block and its loader with:

```tsx
  const [domains, setDomains] = useState<AllowedDomain[]>([])
  const [newDomain, setNewDomain] = useState('')
  const [newNote, setNewNote] = useState('')
  const [addBusy, setAddBusy] = useState(false)
  const [removeBusyId, setRemoveBusyId] = useState<string | null>(null)
  const [pendingRemove, setPendingRemove] = useState<AllowedDomain | null>(null)
  const [domainsVisible, setDomainsVisible] = useState(PAGE_SIZE)

  const loadDomains = () =>
    supabase.from('allowed_email_domains').select('id, domain, note, created_at').order('domain')
      .then(({ data, error: fetchErr }) => {
        if (fetchErr) {
          setError(fetchErr.message)
          return
        }
        setDomains((data as AllowedDomain[]) ?? [])
      })

  useEffect(() => { loadDomains() }, [])

  const addDomain = async () => {
    const domain = normalizeDomain(newDomain)
    if (!isValidDomain(domain)) {
      setError(
        newDomain.includes('@')
          ? 'Enter a domain only, without an email address — for example adelanteabroad.com'
          : 'Enter a valid domain, for example adelanteabroad.com',
      )
      return
    }
    setAddBusy(true)
    setError(null)
    const { error: insErr } = await supabase.from('allowed_email_domains')
      .insert({ domain, note: newNote.trim() })
    if (insErr) {
      setError(insErr.code === '23505' ? 'That domain is already on the list.' : insErr.message)
      setAddBusy(false)
      return
    }
    setNewDomain('')
    setNewNote('')
    await loadDomains()
    setAddBusy(false)
  }

  const removeDomain = async (entry: AllowedDomain) => {
    setRemoveBusyId(entry.id)
    setError(null)
    const { error: delErr } = await supabase.from('allowed_email_domains').delete().eq('id', entry.id)
    if (delErr) {
      setError(delErr.message)
      setRemoveBusyId(null)
      return
    }
    await loadDomains()
    setRemoveBusyId(null)
  }

  const visibleDomains = domains.slice(0, domainsVisible)
  const trimmedNewDomain = normalizeDomain(newDomain)
  const isNewDomainValid = isValidDomain(trimmedNewDomain)
```

Delete `addEmail`, `removeEmail`, `allowlistMessage`, `allowlistVisible`, `trimmedNewEmail` and `isNewEmailValid` entirely.

- [ ] **Step 5: Add the access revocation action**

Dropping the per-address allowlist removed the only way to block someone, so
`set_user_access` replaces it. Without this step it would ship as dead code and the
admin would silently lose a capability they have today.

Add alongside `setAdmin`:

```tsx
  const [pendingAccess, setPendingAccess] = useState<UserRow | null>(null)

  const setAccess = async (user: UserRow, allowed: boolean) => {
    setBusyId(user.id)
    setError(null)
    const { error: rpcErr } = await supabase.rpc('set_user_access', {
      p_user_id: user.id,
      p_allowed: allowed,
    })
    if (rpcErr) {
      setError(rpcErr.message)
      setBusyId(null)
      return
    }
    await load()
    setBusyId(null)
  }
```

- [ ] **Step 6: Render the revoke control on each user row**

In the user row, directly after the `{u.is_admin && (...)}` Admin chip, add a
revoked chip:

```tsx
                  {u.is_blocked && (
                    <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-red-50 text-red-600 text-[10px] font-medium px-2 py-1">
                      <Ban className="size-3.5" strokeWidth={2.5} aria-hidden="true" />
                      Revoked
                    </span>
                  )}
```

and, immediately after the existing admin button pair, add the access control. An
admin cannot be blocked — the RPC refuses it — so the control is hidden for admins
rather than offered and then rejected:

```tsx
                  {!u.is_admin && (
                    u.is_blocked ? (
                      <button
                        onClick={() => setAccess(u, true)}
                        disabled={busy}
                        className="shrink-0 text-sm text-brand-700 px-2 py-1.5 rounded-md hover:bg-brand-50 disabled:opacity-50"
                      >
                        {busy ? 'Working…' : 'Restore'}
                      </button>
                    ) : (
                      <button
                        onClick={() => setPendingAccess(u)}
                        disabled={busy}
                        className="shrink-0 text-sm text-red-500 px-2 py-1.5 rounded-md hover:bg-red-50 disabled:opacity-50"
                      >
                        Revoke
                      </button>
                    )
                  )}
```

and add the confirmation dialog next to the existing `pendingRevoke` one:

```tsx
      <ConfirmDialog
        open={pendingAccess !== null}
        destructive
        title="Revoke access?"
        message={
          <>
            Revoke access for <b>{pendingAccess?.full_name || pendingAccess?.email}</b>? They will be
            signed out and cannot sign in again until you restore them. Their account and order
            history are kept.
          </>
        }
        confirmLabel="Revoke"
        busy={busyId === pendingAccess?.id}
        busyLabel="Revoking…"
        onConfirm={async () => {
          if (pendingAccess) await setAccess(pendingAccess, false)
          setPendingAccess(null)
        }}
        onCancel={() => setPendingAccess(null)}
      />
```

- [ ] **Step 7: Render the pending queue**

Insert directly after the `<h1>Users</h1>` line:

```tsx
      {pending.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-display text-lg font-bold flex items-center gap-1.5">
            <UserPlus className="size-5 text-brand-600" strokeWidth={2.5} aria-hidden="true" />
            Pending registrations
            <span className="rounded-full bg-brand-50 text-brand-700 text-[10px] font-medium px-2 py-0.5">
              {pending.length}
            </span>
          </h2>
          <p className="text-sm text-ink-500">
            These people registered and are waiting to be confirmed. They cannot sign in to the
            store until you confirm them.
          </p>
          {pending.map((p) => {
            const busy = pendingBusyId === p.id
            return (
              <div key={p.id} className="rounded-lg bg-surface-raised p-3 shadow-card flex items-center gap-3">
                <div className="grow min-w-0">
                  <p className="font-medium text-sm truncate">{p.full_name || p.email}</p>
                  <p className="text-xs text-ink-500 truncate">{p.email}</p>
                </div>
                <button
                  onClick={() => decide(p, 'rejected')}
                  disabled={busy}
                  className="shrink-0 text-sm text-red-500 px-2 py-1.5 rounded-md hover:bg-red-50 disabled:opacity-50"
                >
                  Reject
                </button>
                <button
                  onClick={() => decide(p, 'approved')}
                  disabled={busy}
                  className="shrink-0 text-sm bg-brand-700 text-white px-3 py-1.5 rounded-md font-medium disabled:opacity-50"
                >
                  {busy ? 'Working…' : 'Confirm'}
                </button>
              </div>
            )
          })}
        </section>
      )}
```

- [ ] **Step 8: Replace the "Allowed emails" section**

Replace the whole block from `<h2 ...>Allowed emails</h2>` down to the end of its `ConfirmDialog` with:

```tsx
      <h2 className="font-display text-lg font-bold pt-2 flex items-center gap-1.5">
        <Globe className="size-5 text-brand-600" strokeWidth={2.5} aria-hidden="true" />
        Allowed domains
      </h2>
      <p className="text-sm text-ink-500">
        Anyone with an email at one of these domains can register. They still need to be
        confirmed above before they can sign in. This list is never shown to users.
      </p>

      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          value={newDomain}
          onChange={(e) => setNewDomain(e.target.value)}
          placeholder="adelanteabroad.com"
          className="grow rounded-md bg-surface-raised border border-line px-3 py-2.5 text-sm outline-none focus-visible:outline-2 focus-visible:outline-brand-700"
        />
        <input
          type="text"
          value={newNote}
          onChange={(e) => setNewNote(e.target.value)}
          placeholder="Note (optional)"
          className="grow rounded-md bg-surface-raised border border-line px-3 py-2.5 text-sm outline-none focus-visible:outline-2 focus-visible:outline-brand-700"
        />
        <button
          onClick={addDomain}
          disabled={addBusy || !isNewDomainValid}
          className="shrink-0 text-sm bg-brand-700 text-white px-3 py-1.5 rounded-md font-medium disabled:opacity-50"
        >
          {addBusy ? 'Adding…' : 'Add'}
        </button>
      </div>

      {domains.length === 0 ? (
        <p className="text-sm text-ink-500">No allowed domains yet — nobody can register.</p>
      ) : (
        <>
          <div className="space-y-2">
            {visibleDomains.map((entry) => {
              const busy = removeBusyId === entry.id
              return (
                <div key={entry.id} className="rounded-lg bg-surface-raised p-3 shadow-card flex items-center gap-3">
                  <div className="grow min-w-0">
                    <p className="font-medium text-sm truncate flex items-center gap-1.5">
                      <Globe className="size-3.5 text-ink-500 shrink-0" strokeWidth={2.5} aria-hidden="true" />
                      {entry.domain}
                    </p>
                    {entry.note && <p className="text-xs text-ink-500 truncate">{entry.note}</p>}
                  </div>
                  <button
                    onClick={() => setPendingRemove(entry)}
                    disabled={busy}
                    className="shrink-0 text-sm text-red-500 px-2 py-1.5 rounded-md hover:bg-red-50 disabled:opacity-50"
                  >
                    {busy ? 'Working…' : 'Remove'}
                  </button>
                </div>
              )
            })}
          </div>
          <p className="text-xs text-ink-500">
            Showing {visibleDomains.length} of {domains.length} domain{domains.length === 1 ? '' : 's'}
          </p>
          {domains.length > domainsVisible && (
            <button
              onClick={() => setDomainsVisible((c) => c + PAGE_SIZE)}
              className="w-full rounded-2xl bg-white shadow-sm py-3.5 font-medium text-ink-900 active:scale-[0.98] transition"
            >
              Show more
            </button>
          )}
        </>
      )}

      <ConfirmDialog
        open={pendingRemove !== null}
        destructive
        title="Remove allowed domain?"
        message={
          <>
            Remove <b>{pendingRemove?.domain}</b>? Nobody at that domain will be able to register.
            People from it who already have confirmed accounts keep their access.
          </>
        }
        confirmLabel="Remove"
        busy={removeBusyId === pendingRemove?.id}
        busyLabel="Removing…"
        onConfirm={async () => {
          if (pendingRemove) await removeDomain(pendingRemove)
          setPendingRemove(null)
        }}
        onCancel={() => setPendingRemove(null)}
      />
```

- [ ] **Step 9: Verify end to end**

With `npx supabase start`, the function served, and `npm run dev` running, as an admin on `/admin/users`:

1. The registration from Task 6 appears under **Pending registrations**, and does **not** also appear in the user list below.
2. Typing `portia@adelanteabroad.com` into the domain box shows the "domain only" guidance and the Add button stays disabled.
3. Adding `example.com` succeeds and it appears in the list.
4. Adding `Example.com` reports "That domain is already on the list."
5. Clicking **Confirm** moves the person out of the queue into the user list, and signing in as them now reaches the store.
6. Clicking **Reject** on another registration leaves them on the rejected screen when they sign in.
7. **Revoke** on a non-admin user shows the Revoked chip; signing in as them fails the guard. **Restore** puts them back.
8. No Revoke control is offered on an admin row.

- [ ] **Step 10: Verify the whole build**

Run: `npx tsc -b && npm test && npm run lint && npx supabase test db`
Expected: everything green.

Then confirm nothing references the removed allowlist:

```bash
grep -rn "EmailAllowlistEntry\|set_email_access\|email_allowlist" src/ supabase/functions/ supabase/tests/
```

Expected: no matches.

- [ ] **Step 11: Hand off**

Do **not** commit. Suggested command for the repo owner:

```bash
git add src/pages/admin/Users.tsx && git commit -m "feat: admin pending queue, allowed domains, access revocation"
```
