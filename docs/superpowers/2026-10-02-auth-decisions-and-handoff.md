# Email/password auth — decisions log and handoff

Companion to:
- Spec: `docs/superpowers/specs/2026-10-01-email-password-auth-design.md`
- Plan: `docs/superpowers/plans/2026-10-01-email-password-auth.md`
- Full ledger, agent reports and review packages: `.superpowers/sdd/2026-10-01-email-password-auth/`

Nothing is committed. All work sits uncommitted in the working tree on `main`
(base `1035dee`), per the standing rule against state-changing git commands.

## Deployed to production, 2026-10-02

- Both migrations applied via `supabase db push`; `migration list --linked` reports
  18 applied, 0 pending.
- `register` Edge Function deployed and probed live (see below).
- `verify-payment` redeployed with its `is_active_user()` gate.
- **NOT yet deployed: the frontend build.** Until it ships, `/admin/users` errors
  against the renamed table, so nobody can be confirmed — registration works but no
  one can be let in.

## Verified state

| Check | Result |
|---|---|
| `npx tsc -b` | exit 0, clean |
| `npm test` | 160/160 passing |
| `npm run build` | succeeds |
| `npm run lint` | 0 errors (2 pre-existing warnings in `supabase/functions`) |
| Real domain in shipped JS | none |
| `npx supabase db reset` (local) | both new migrations apply cleanly, in order |
| `npx supabase test db` | **285/285 passing across 6 suites** |

Verified 2026-10-02. Docker Desktop was installed but not running, and its CLI
was not on PATH (`~/.docker/bin` is missing from it) — that, not a missing
install, was the whole blocker.

Note: `supabase start` alone was NOT enough. It reused a stale pre-existing
local database volume and reported success while the new columns were absent,
producing exactly the `column profiles.approval_status does not exist` error
seen in the app. `supabase db reset` is what rebuilds local from all migrations.

## Before go-live

1. ~~Run the pgTAP suites.~~ **Done — 285/285 pass.** The ~900 lines of
   security-critical SQL now apply cleanly and every assertion holds, including
   every pending-account denial, the admin-only domain list, and the function
   privilege revokes.
2. **Decide `[auth.email] enable_signup`.** See "The one open decision" below.
3. ~~Deploy the register function.~~ **Done 2026-10-02.** Probed live: a malformed
   email returns 400 with the precise message, a disallowed domain returns the
   generic 403. No 401, so `verify_jwt = false` took effect; and the 403 proves the
   service role can reach `is_email_domain_allowed` in production, i.e. the
   revoke/grant chain is correct. Neither probe created an account.

   **`verify-payment` also deployed 2026-10-02**, carrying the `is_active_user()`
   gate that stops a blocked or rejected user reusing an earlier receipt to drive an
   unpaid order to `paid`. Probed live: 401 without a JWT, confirming verification
   stayed ON for this function (its gate depends on a real caller identity), while
   `register` returns 400 rather than 401 — so the per-function `verify_jwt` settings
   applied correctly rather than globally.
4. **Apply migrations and frontend together.** Deploying the frontend ahead of
   the migrations makes every user read as approved; deploying the migrations
   ahead of the frontend breaks `/admin/users`.
5. **Check the archived allowlist.** `email_allowlist` was renamed to
   `email_allowlist_archived_20261002` rather than dropped, because nobody could
   verify it held only `portia@adelanteabroad.com`. Reconcile it against the
   domain list, then drop it.

## The one open decision

Anyone holding the public anon key can call `supabase.auth.signUp()` directly and
learn from the response whether an address already has an account, and whether a
domain is eligible. The register Edge Function returns deliberately identical 403s
to avoid exactly this; Supabase's own signup endpoint sits beside it and answers
anyway.

The obvious fix — `[auth.email] enable_signup = false` — **must not be applied**.
That key maps to `GOTRUE_EXTERNAL_EMAIL_ENABLED`, which gates the entire email
provider. GoTrue's password grant checks the same flag and returns 422
"Email logins are disabled", so setting it false breaks `signInWithPassword` for
every user, including you. Verified against GoTrue's source, not assumed.

Options:
- **Accept it.** You already chose to show an error on a disallowed domain, which
  discloses domain eligibility by design. This leaks one step further, to someone
  who already knows a specific address to test.
- **Enable email confirmations.** GoTrue stops saying "already registered" when
  confirmations are on. Costs an SMTP provider and reintroduces the verification
  email you declined.

Recommendation: accept it. The domain list is what mattered and it is protected.

## Decisions taken on your behalf

Every one is reversible. Grouped by consequence.

### Reversals of my own earlier instructions

| Decision | Why |
|---|---|
| **Did not disable `[auth.email] enable_signup`** | I ruled to disable it; an implementer refused and reported BLOCKED. It was right — the key gates the whole email provider, so this would have broken password login for everyone. Confirmed from GoTrue source. |
| **Guard only rejection of an admin, not every status change** | I asked for a guard on all status changes; the implementer argued that blocking "approved" would trap a user promoted to admin while still pending, who could then never be confirmed. Its reasoning was better than mine. |
| **Corrected the spec's success criterion 4** | My original wording ("no surface reveals which domains are allowed") could not coexist with your explicit request to show an error on a disallowed domain. The spec now states the real property and its accepted limit. |

### Data safety

| Decision | Why |
|---|---|
| **Archived `email_allowlist` instead of dropping it** | The seed assumes it held one row. If it held others, those people lose access and the dropped table was the only record of who they were. |
| **`approved_by` → `on delete set null`** | Otherwise the FK blocks deleting any admin who ever confirmed a registration. |
| **Added `set_user_access` + a Revoke/Restore UI** | Dropping the per-address allowlist removed the only way to block someone. Without this the capability vanished silently. |

### Security hardening beyond the plan

| Decision | Why |
|---|---|
| **Revoked `is_email_domain_allowed` from anon/authenticated** | PostgREST exposed it as an anon-callable RPC — the whole list was enumerable in seconds. |
| **Revoked default table grants on `allowed_email_domains`** | RLS was the only barrier on the most secrecy-sensitive table, against your own wallet-migration convention. |
| **Gated pending users' writes, not just reads** | The plan gated reads but left `request_topup` and storage uploads open, so an unconfirmed account could still file top-ups and upload files. |
| **Gated `verify-payment` on account status** | A blocked or rejected user with an unpaid order could reuse an earlier receipt and drive it to paid. |
| **Narrowed `profiles` reads to own-row + admin** | Approved users could read every registered email, indirectly revealing which domains are in use. Verified first that no customer screen needs other users' rows. |
| **Removed `adelanteabroad.com` from `Users.tsx`** | A real allowed domain was hardcoded as placeholder text and shipped in the public JS bundle. |
| **Rewrote `src/pages/Privacy.tsx`** | It named a live allowed domain publicly, and described a mechanism that no longer exists. Two further statements had become false — including one where this change made the policy *overstate* data exposure. |

### Correctness and usability

| Decision | Why |
|---|---|
| **Made Reject reversible** | It was a single unconfirmed click with no undo; rejected users dropped into the user list indistinguishable from approved ones. Now confirmed, chipped, and restorable. |
| **Guards fail closed on a null profile** | A failed profile fetch rendered the store shell. RLS denied the data, but the UI should not treat "unknown" as "approved". |
| **Removed `normalizeEmail`/`emailDomain`** | Zero production callers; 12 tests exercising dead code. |
| **Kept `orders`/`cancel_own_order` ungated** | They expose only the caller's own rows and leak nothing about other users or the domain list. Rationale is now recorded in the migration. |
| **Accepted gating `public buckets read`** | Listing `qr-codes` exposed payment-method data that the gated `pm read` policy hides. Verified both buckets are public and reached only via `getPublicUrl`, so storefront images cannot break. |

### Process

| Decision | Why |
|---|---|
| **No worktree, no branch, no commits** | Your standing rules. Everything lands uncommitted for you to review. |
| **Kept the SDD workspace** | The usual step deletes it because "git history is the record". There are no commits, so it is the *only* record of the reasoning behind these decisions. |

## Known residuals

- The register endpoint is unauthenticated and unthrottled, and marks accounts
  email-confirmed. Someone could pre-register a colleague's address. The pending
  queue now shows registration dates so a flood is visible.
- Timing side-channel: the disallowed-domain path returns before `createUser` runs
  bcrypt, so the two identical 403s differ in latency.
- A transient profile re-fetch failure now drops an active user to the
  "Couldn't load your account" screen until reload.
- `Privacy.tsx` still does not mention the prepaid wallet or top-up proofs. Predates
  this work.
