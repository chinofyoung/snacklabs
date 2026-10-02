# Notifications — decisions log and handoff

Companion to:
- Spec: `docs/superpowers/specs/2026-10-02-notifications-design.md`
- Plan: `docs/superpowers/plans/2026-10-02-notifications.md`
- Full ledger, agent reports and review packages: `.superpowers/sdd/2026-10-02-notifications/`

Nothing is committed. All work sits uncommitted in the working tree on `main`
(base `28b6f3b`), per the standing rule against state-changing git commands.

## What it does

A database trigger writes a durable `notifications` row whenever:

| Event | Who is told |
|---|---|
| Top-up approved | the customer |
| Top-up rejected | the customer |
| New top-up request | every admin except the actor |
| New registration pending | every admin except the actor |
| Order entered `needs_review` | every admin |

The row drives an **Alerts** item in the persistent nav of both layouts, with a
live unread count over Supabase Realtime. That half needs no permission, no
service worker and no particular OS version, so it works on every browser. A web
push is attempted on top and is allowed to fail.

## Verified state

| Check | Result |
|---|---|
| `npx tsc -b` | clean |
| `npm test` | 220/220 (14 files) |
| `npm run build` | succeeds |
| `npm run lint` | 0 errors (2 pre-existing warnings) |
| `npx supabase test db` | **382/382 across 11 suites** |
| `public/sw.js` listeners | exactly 2 — `push`, `notificationclick`, no `fetch` |

## Before go-live — three things fail SILENTLY if missed

1. **The two vault secrets.** `send_push_url` and `send_push_key` must exist on
   the live project, and `send_push_key` must be **byte-identical** to the
   function's `SUPABASE_SERVICE_ROLE_KEY` — the legacy JWT, not a new-style
   `sb_secret_…` key. If either is missing or mismatched, the notification row
   still commits and the in-app badge still works, so nothing looks broken —
   and no push ever arrives, with no error anywhere.
2. **`/sw.js` must be served as JavaScript.** `public/_redirects` is
   `/* /index.html 200`. Netlify serves static files first, so this is fine
   there; on a host that applies the fallback first, the service worker never
   registers and the toggle simply reads "stalled".
3. **`pg_net` must be enabled** on the hosted project. The migration's
   `create extension if not exists pg_net` may need dashboard approval.

Then: generate a VAPID keypair (`npx web-push generate-vapid-keys`), put the
public half in `.env` as `VITE_VAPID_PUBLIC_KEY`, set the private half with
`supabase secrets set VAPID_PRIVATE_KEY=…`, and deploy `send-push`.

**One thing to check before `db push`:** the endpoint allowlist is added as a
*validated* CHECK constraint. If the live `push_subscriptions` table somehow
holds a row with a non-allowlisted endpoint, the migration will fail. It is a
new table in this same series, so it should be empty.

## A product constraint worth knowing

Closing the SSRF meant restricting push endpoints to a host allowlist. Push
therefore works on **Chrome/Android, Firefox, Edge and Safari**. Samsung
Internet, UnifiedPush and de-Googled Chrome are refused outright — those users
get the in-app badge, which works everywhere, but cannot enable lock-screen
notifications. Worth one real-device check on Chrome and on Safari.

## Decisions taken on your behalf

All reversible. Grouped by consequence.

### Security — things found by running the code, not reading it

| Decision | Why |
|---|---|
| **Revoked `TRUNCATE` from authenticated on `notifications`** | My grant block was a no-op. The default ACL left every signed-in user holding TRUNCATE, which **bypasses RLS** — anyone could have emptied the table. |
| **Blocked SSRF with a table CHECK constraint, not just the RPC** | I briefed the check into `claim_push_subscription`. The implementer found a plain client-side insert bypassed it entirely and stored `https://169.254.169.254/latest/meta-data/` — the cloud metadata endpoint. The constraint covers every write path. 19 bypass attempts tried and rejected. |
| **`send-push` requires the service-role key** | Its only auth was the gateway JWT check, which the public anon key passes — so anyone could replay a push for a known notification id. |
| **`update` on `notifications` restricted to `read_at`** | A notification is the record of what the system told someone; the recipient should not be able to rewrite its title, body or link. |

### Shared devices — an office pantry has them

| Decision | Why |
|---|---|
| **`claim_push_subscription` takes an endpoint over from its previous owner** | Push endpoints are unique per *browser*, not per person. Without this, a colleague's "Your top-up of ₱500 was approved" arrives on the phone you are holding. |
| **Sign-out unsubscribes the browser** | The same leak by another path, and it was the final review's one blocker. The toggle even showed the new person "On for this device", so they had no reason to touch it. |
| **The in-app list is gated on an owner id** | So a previous account's notifications cannot render for even one frame after a switch. |

### Design corrections found during implementation

| Decision | Why |
|---|---|
| **Triggers on tables, not edits to the RPCs** | `needs_review` is written directly by an Edge Function, so an RPC hook would have missed it — and the alternative meant retyping `approve_topup`, which carries wallet locking and a self-approval guard. |
| **The iOS check runs before the capability probes** | iOS Safari *hides* `PushManager` in a tab, so my original order would have told iPhone users "your browser doesn't support this" instead of "add it to your Home Screen". |
| **iPadOS detected via `maxTouchPoints`** | iPadOS sends a Macintosh user agent, so an iPad in a tab would otherwise read as unsupported. |
| **`notifications` added to the realtime publication** | My plan never did this. Without it the badge never updates live while the channel still reports healthy — a silent failure. |
| **Alerts is a persistent nav item in both layouts** | Your directive; it superseded the spec, and the spec has been updated to match. |

### Tests that proved nothing until they were rewritten

Three of my tests passed while asserting nothing, and each was caught by an
implementer rather than a reviewer:

- The exception-handler test re-approved an already-rejected row, so no
  notification fired and no dispatch ran. Replaced with one that credits a real
  wallet through `approve_topup` with `net.http_post` genuinely raising — and
  goes red at ₱0.00 without the handler.
- The capability-detection tests ran in Node without `window`, so five of six
  failed and the sixth passed vacuously.
- The mark-as-read effect was gated on `unread > 0` with an empty dependency
  array, so on a direct visit it would never have fired at all.

### Deliberately not done

| Decision | Why |
|---|---|
| **Nav labels left at `text-ink-500`** | 3.73:1 at 10px, which fails AA — and the new "Alerts" label inherits it. But it is pre-existing and applies to every nav label in both layouts, so fixing it is an app-wide visual change you did not ask for. **Your call.** |
| **`exception when others` left as-is** | It does not catch `query_canceled`, so a statement timeout could in principle escape and roll back a top-up. Catching it would be worse than the disease. |
| **The service worker has no `fetch` handler** | Offline caching is separate work with its own design. |

## Known follow-ups

- **Session expiry does not unsubscribe.** Deliberate sign-out is fully handled;
  an expired session is not, and is only half-fixable (an expired session cannot
  perform the RLS DELETE). The tractable half is calling `sub.unsubscribe()` on a
  `SIGNED_OUT` transition.
- **The subscribe success path is unverified end to end** — granting permission,
  subscribing, and receiving a real push on a real installed device. Headless
  Chrome has no permission prompt and no push service. Try it once on a phone.
- **The admin bottom nav is tight at 320px** — six tabs fit with about 2px of
  slack, measured in Chromium's font rather than on a real iPhone SE. Shortening
  "Dashboard" to "Home" would recover roughly 20px if it looks cramped.
- `/notifications` lives inside the customer shell, so an admin tapping Alerts
  leaves the admin chrome. That follows directly from "same link for both".
