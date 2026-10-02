# Email/password registration with admin confirmation

**Date:** 2026-10-01
**Status:** Approved for planning

## Purpose

Today the only way into SnackLabs is "Continue with Google", and eligibility is
decided by a hardcoded `@goabroad.com` check plus a per-address `email_allowlist`
table. Adding a person outside goabroad.com means an admin adding their exact
address by hand.

This replaces that with self-service registration: a person signs up with their
name, email and a password; the email's **domain** must be on an admin-managed
allowlist; and an admin confirms the account before it can do anything. Google
sign-in stays exactly as it is for the people already using it.

## Success criteria

1. A person at an allowed domain can register with first name, last name, email
   and password, and sees a clear "waiting for confirmation" state.
2. An admin sees that registration on `/admin/users`, confirms it, and the person
   can then log in and shop.
3. A person at a domain that is **not** allowed sees an error and cannot register.
4. The allowlist is never published, named, or enumerable in bulk: no page, error
   message or readable table names a domain, and no API returns the list.

   **Known and accepted limit.** Because requirement 3 says a disallowed domain shows
   an error, registration is necessarily an oracle for one candidate domain at a time:
   submit an address, and a 200 means that domain is allowed. This is a deliberate
   trade the repo owner made — usable feedback over probe-resistance — not an
   oversight. What is still protected is *who* has an account: a fresh address at an
   allowed domain returns 200, while BOTH a disallowed domain and an already-registered
   address return an identical 403, so the 403 never reveals whether a given person is
   registered. Closing the remaining oracle would mean dropping the error and showing
   "registration received" unconditionally, which contradicts requirement 3.
5. A registered-but-unconfirmed account can read nothing beyond its own profile.
6. Every existing user keeps working with no action on their part.

## Decisions taken

| Decision | Choice |
|---|---|
| Google sign-in | Stays on the login screen alongside email/password |
| Email verification link | Not required; admin confirmation is the only gate |
| Non-allowed domain | Shows an error, without naming any domain |
| Per-address allowlist | Replaced by the domain allowlist |
| Domain list location | `/admin/users`, where "Allowed emails" lives today |
| Registration fields | First name, last name, email, password |

## Architecture

### Where the domain check runs

The allowlist must never be readable by the browser — if the client can query it,
the list is disclosed and requirement 4 is lost. The check therefore runs
server-side with elevated privilege, in two places:

**Front door — `register` Edge Function (service role).** The client POSTs
`{first_name, last_name, email, password}`. The function validates input, looks up
the domain in `allowed_email_domains` using the service-role key, and either
returns a generic error or creates the user with `auth.admin.createUser`.

**Backstop — `handle_new_user` trigger.** `supabase.auth.signUp()` stays reachable
with the public anon key regardless of what the UI does, and Google OAuth creates
users through a path the Edge Function never sees. The trigger independently
refuses any email whose domain is not allowed.

Rejected alternatives:

- *Trigger only.* A trigger exception surfaces to the browser as
  `AuthApiError: Database error saving new user`, which is indistinguishable from a
  genuine database fault. It would show "you are not eligible" to someone hitting a
  real bug, and hide real bugs as eligibility failures.
- *Client-side pre-check.* Requires the client to read the domain list. Discloses it.

### Non-disclosure

The registration endpoint returns one generic message for every failure that could
otherwise distinguish an allowed domain from a disallowed one:

> This email address can't be used to register. Check with your administrator.

This message is returned for **both** a non-allowed domain and an email that is
already registered. Distinct messages would create an enumeration oracle: learning
that an address is already taken would reveal that its domain is allowed. The cost
is that a returning user who forgot they had signed up gets an unhelpful message;
they recover by using the login form, which tells them their account is pending.

Input-shape errors (malformed email, password too short, missing name) are reported
precisely — they reveal nothing about the allowlist.

## Data model

### New: `allowed_email_domains`

```
id          uuid primary key default gen_random_uuid()
domain      text not null
note        text not null default ''
created_at  timestamptz not null default now()
```

- Unique index on `lower(domain)`.
- RLS: admin-only for **both read and write**. Unlike `email_allowlist`, which was
  also admin-only, this table's secrecy is a stated requirement rather than a
  convenience, and the pgTAP suite asserts a non-admin cannot read it.
- Domains are stored bare and lowercased: `goabroad.com`, never `@goabroad.com`.
- Seeded with `goabroad.com` (today's hardcoded rule) and `adelanteabroad.com`
  (from the single existing `email_allowlist` row).

### Changed: `profiles`

Added columns:

```
first_name       text not null default ''
last_name        text not null default ''
approval_status  text not null check (approval_status in ('pending','approved','rejected'))
approved_by      uuid references public.profiles(id)
approved_at      timestamptz
```

`full_name` is **kept**. Every existing page reads it, so keeping it means this
change touches no order, wallet or sales code.

`handle_new_user` must serve two sign-up paths with different metadata shapes:

- **Email/password** — metadata carries `first_name` and `last_name`. The trigger
  stores both and composes `full_name` as `first_name || ' ' || last_name`.
- **Google OAuth** — metadata carries `full_name` and `avatar_url`, and no split
  name. The trigger stores `full_name` as given and leaves `first_name` and
  `last_name` empty rather than guessing a split; names do not reliably divide on
  whitespace.

Existing rows are untouched: their `full_name` is preserved and their `first_name`
and `last_name` default to empty. `full_name` therefore remains the single display
field across the app, and `first_name`/`last_name` are populated only where they
were actually collected.

Migration order matters:

1. Add `approval_status` with default `'approved'` — this backfills every existing
   row as approved, so no current user is disrupted.
2. Then `alter column approval_status set default 'pending'` — so every new account
   requires confirmation.

Doing this in one step with a `'pending'` default would lock out every existing user.

### Removed: `email_allowlist`, `set_email_access`

Both are dropped. `set_email_access` was also the only way to set `is_blocked`, so
that capability moves to a new function rather than being lost:

```
set_user_access(p_user_id uuid, p_allowed boolean) returns text
```

Admin-only, refuses to block an admin (preserving the existing
`protect_last_admin` intent), and is surfaced as a per-user **Revoke access**
button on `/admin/users`.

### New: `is_active_user()`

```
approval_status = 'approved' and not is_blocked
```

Security-definer, mirroring the existing `is_admin()` helper.

## Closing the pending-user hole

This is the security-critical part of the change.

`profiles read all`, `items read` and `pm read` are currently
`for select to authenticated using (true)`. A registered-but-unconfirmed user holds
a valid JWT and is `authenticated`, so without this work they could read the entire
user list, the full catalogue and every payment method while still "pending".

Changes:

- `profiles read all` → readable when `is_active_user()` or `is_admin()`, plus an
  always-allowed read of one's own row (`id = auth.uid()`), which the pending screen
  and `AuthContext` need.
- `items read`, `pm read` → `using (public.is_active_user())`.
- `create_order` → raises on a non-approved caller, alongside its existing
  `is_blocked` check.
- Wallet, `wallet_entries` and `topup_requests` read policies and the top-up RPCs →
  gated on `is_active_user()`.

A pending session can therefore read its own profile row and nothing else.

## Flows

### Registration

1. `/register` collects first name, last name, email, password, confirm password.
2. Client-side validation: all fields present, email well-formed, password meets the
   project minimum (`minimum_password_length = 6` in `supabase/config.toml`),
   confirmation matches.
3. POST to the `register` Edge Function.
4. Function lowercases and trims the email, extracts the domain, and checks
   `allowed_email_domains`.
   - Not allowed, or already registered → generic error (see Non-disclosure).
   - Allowed → `auth.admin.createUser({ email, password, email_confirm: true,
     user_metadata: { first_name, last_name } })`. `email_confirm: true` marks the
     address confirmed without sending mail, since admin confirmation is the gate
     and no SMTP provider is configured.
5. The trigger writes a `profiles` row with `approval_status = 'pending'`.
6. The UI shows the "waiting for confirmation" state. The user is **not** signed in.

### Login

`/login` keeps the Google button and gains an email/password form above it, plus a
link to `/register`.

After `signInWithPassword` succeeds, `AuthContext` loads the profile and the guard
routes on `approval_status`:

- `approved` → normal destination (`/store`, or `/admin` for admins)
- `pending` → pending screen, with a sign-out action
- `rejected` → rejected screen, with a sign-out action
- `is_blocked` → existing behaviour, signed out

### Google sign-in

Unchanged for existing users: the migration marked them `approved`.

A **new** Google user at an allowed domain lands `pending` like any other new
account, and an admin confirms them. A new Google user at a disallowed domain is
refused by the trigger; the resulting error is the clumsy Supabase OAuth error, which
is the behaviour today and is not made worse by this change.

### Admin confirmation

`/admin/users` gains a **Pending registrations** section above the user list:
name, email, registered date, with **Confirm** and **Reject** actions calling

```
set_registration_status(p_user_id uuid, p_status text) returns text
```

Admin-only; accepts `'approved'` or `'rejected'`; records `approved_by` and
`approved_at`.

The "Allowed emails" section becomes **Allowed domains** — the same add/remove
layout, taking `adelanteabroad.com` rather than `portia@adelanteabroad.com`, with
input validation rejecting anything containing `@`.

## Components

| Unit | Responsibility | Depends on |
|---|---|---|
| `src/lib/emailDomain.ts` | Pure: normalise an email, extract its domain, validate a domain string | nothing |
| `supabase/functions/register/index.ts` | Domain check + user creation under service role; uniform error surface | `allowed_email_domains`, auth admin API |
| `20261002000000_auth_domains.sql` | Schema, RLS, helpers, seed, teardown of the old allowlist | existing schema |
| `src/pages/Register.tsx` | Registration form and its states | Edge Function, `emailDomain` |
| `src/components/guards.tsx` | Routes on session + approval status | `AuthContext` |
| `src/pages/admin/Users.tsx` | Pending queue, domain list, revoke access | RPCs above |

`emailDomain.ts` is deliberately pure and dependency-free so the domain rules are
unit-testable without a database, and so the Edge Function and the client agree on
normalisation.

## Error handling

| Condition | Surface |
|---|---|
| Malformed email / short password / missing name | Precise, inline on the form |
| Domain not allowed | Generic message; HTTP 403 |
| Email already registered | Same generic message; HTTP 403 |
| Edge Function unreachable / 5xx | "Something went wrong. Please try again." — distinct from the eligibility message, so real outages are visible |
| Login as pending | Pending screen, not an error |
| Login as rejected | Rejected screen with sign-out |

The Edge Function logs the real reason server-side so admins can diagnose what the
user is not told.

## Testing

**pgTAP** (`supabase/tests/auth_domains.test.sql`):
- a non-admin cannot read `allowed_email_domains` — the disclosure guarantee
- `handle_new_user` rejects a disallowed domain and accepts an allowed one
- new profiles are `pending`; the migration left existing profiles `approved`
- `is_active_user()` is false for pending, rejected and blocked
- a pending user cannot read `items`, `payment_methods` or other profiles
- a pending user can read their own profile row
- `create_order` refuses a pending caller
- `set_registration_status` and `set_user_access` refuse non-admins
- `set_user_access` refuses to block an admin

**vitest** (`src/lib/emailDomain.test.ts`):
- domain extraction, case and whitespace normalisation
- rejects malformed addresses and `@`-prefixed domain input
- subdomain handling: `a@mail.goabroad.com` does **not** match `goabroad.com`

**Manual verification:** register at an allowed domain → confirm as admin → log in
and place an order; register at a disallowed domain → see the generic error; confirm
an existing Google user is unaffected.

## Out of scope

- Password reset / forgot-password (no SMTP configured; separate piece of work)
- Email verification links
- Letting existing Google users set a password
- Self-service domain requests

## Migration risk

Seeding `adelanteabroad.com` widens eligibility from one address to everyone at that
domain. This is the requested behaviour and is contained by mandatory admin
confirmation: anyone at that domain may *register*, but can do nothing until an
admin confirms them.
