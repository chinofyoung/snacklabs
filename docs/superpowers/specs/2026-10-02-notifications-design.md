# Notifications

**Date:** 2026-10-02
**Status:** Awaiting review

## Purpose

SnackLabs has no notifications of any kind — no realtime, no email, no push.
That leaves people waiting on each other with no signal:

- A customer uploads proof of a top-up and waits for a human to approve it. Real
  money is in limbo, and the only way to find out is to reopen `/wallet`.
- An admin is the bottleneck for top-ups, order reviews and now registrations,
  and nothing tells them any of it happened. They have to remember to look.

This builds the smallest thing that closes both loops: a durable notification
record, an in-app badge and list, and web push for when the app is closed.

## Scope

**In scope — five events:**

| Event | Recipient |
|---|---|
| Top-up approved | the customer |
| Top-up rejected | the customer |
| New top-up request | all admins |
| New registration pending | all admins |
| Order moved to `needs_review` | all admins |

**Explicitly out of scope**, decided by the repo owner:

- "Registration confirmed" to the new person
- "Payment verified" to the customer
- Email of any kind (no SMTP provider is configured)
- Offline caching. The service worker added here deliberately has NO `fetch`
  handler — adding one changes how the whole app loads and is a larger, riskier
  change than notifications.

## Success criteria

1. Approving or rejecting a top-up notifies that customer, and the notification
   survives in the app whether or not a push was delivered.
2. A new top-up request, a new pending registration, or an order entering
   `needs_review` notifies every admin except the person who caused it.
3. An unread count is visible in the app without any permission being granted,
   on every browser, including an iPhone that never installed the app.
4. With permission granted and the app installed, a notification reaches the
   device while the app is closed.
5. A notification failing to send can never prevent the underlying action —
   an approval must not roll back because a push failed.
6. No user can read another user's notifications.

## Architecture

### Events are observed, not reported

Every notification originates from a **trigger on the table whose state
changed**, never from the function or UI that changed it.

This was a deliberate revision. The first design put the inserts inside the
existing RPCs (`approve_topup`, `reject_topup`, `request_topup`,
`handle_new_user`). Two things argued against it:

1. `needs_review` is not set by an RPC at all. `supabase/functions/verify-payment/index.ts`
   writes it directly with the service role, so an RPC-based hook would have
   missed the single event an admin most needs.
2. Hooking the others would mean `create or replace` on three large
   security-definer functions. `approve_topup` alone carries wallet row locking,
   a self-approval guard and a status check. Retyping that body to add one line
   risks silently dropping logic — a hazard this repo has already seen during the
   auth work, where mechanical diffs were needed to prove nothing was lost.

Triggers avoid both. They fire for any caller — the admin UI, an Edge Function,
psql — and each is small enough to read and test on its own. No existing function
body is touched.

### Delivery is a disposable side effect

The `notifications` row is the source of truth. Push is attempted afterwards and
is allowed to fail. If Apple drops it, if permission was never granted, if the
home-screen icon was reinstalled and the subscription is stale — the notification
is still in the app with an unread badge.

This is why requirement 3 is satisfied on every browser and requirement 4 only on
some.

## Data model

### `notifications`

```
id          uuid primary key default gen_random_uuid()
user_id     uuid not null references public.profiles(id) on delete cascade
kind        text not null check (kind in (
              'topup_approved', 'topup_rejected', 'topup_requested',
              'registration_pending', 'order_needs_review'))
title       text not null
body        text not null
link        text not null default ''
read_at     timestamptz
created_at  timestamptz not null default now()
```

One row per recipient. An admin event fans out to one row per admin rather than a
single row carrying a role. That makes RLS trivially `user_id = auth.uid()`, gives
each admin independent unread state, and costs nothing at this scale.

`link` is the in-app route to open (`/wallet`, `/admin/topups`, `/admin/users`,
`/admin/orders`). Stored rather than derived so the push handler and the list page
cannot disagree.

RLS:
- `select` where `user_id = auth.uid()`
- `update` where `user_id = auth.uid()` — exists only so a person can mark their
  own notification read
- **no insert or delete policy at all.** Only security-definer functions write
  here, matching how `wallets` and `wallet_entries` are already handled.

Indexes: `(user_id, created_at desc)` for the list; a partial index on
`(user_id) where read_at is null` for the badge count.

### `push_subscriptions`

```
id            uuid primary key default gen_random_uuid()
user_id       uuid not null references public.profiles(id) on delete cascade
endpoint      text not null unique
p256dh        text not null
auth          text not null
user_agent    text not null default ''
created_at    timestamptz not null default now()
```

No `last_seen_at`: nothing in this design would ever write it. Dead subscriptions
are pruned on a 404/410 from the push service, which is a positive signal rather
than an inferred one.

`endpoint` is unique because the push service issues one per browser; it is the
natural key for replacing a refreshed subscription and for pruning a dead one.

RLS: a person may `select`, `insert` and `delete` their own rows — enough to
register a browser and to turn notifications off. The sender reads with the
service role.

## Components

| Unit | Responsibility | Depends on |
|---|---|---|
| `notify_user(uuid, text, text, text, text)` | Insert one notification row | `notifications` |
| `notify_admins(text, text, text, text)` | Fan out to every admin except `auth.uid()` | `notify_user`, `profiles` |
| trigger on `topup_requests` | approved / rejected / requested | `notify_user`, `notify_admins` |
| trigger on `profiles` | registration pending | `notify_admins` |
| trigger on `orders` | entered `needs_review` | `notify_admins` |
| trigger on `notifications` | fire the push attempt via `pg_net` | `send-push` |
| `supabase/functions/send-push` | Sign and deliver Web Push; prune dead subscriptions | `push_subscriptions`, VAPID |
| `public/sw.js` | `push` and `notificationclick` only | — |
| `src/lib/push.ts` | Capability detection, subscribe/unsubscribe | `sw.js` |
| `src/context/NotificationsContext.tsx` | Realtime subscription, unread count | `notifications` |
| `src/pages/Notifications.tsx` | The list, mark-as-read | `NotificationsContext` |

`notify_admins` excludes `auth.uid()` so nobody is notified about their own
action. When the actor is the service role — as it is for `order_needs_review` —
`auth.uid()` is null and every admin is notified, which is correct.

Both helpers are `security definer` and exist only to be called from triggers.
Following the convention established by the wallet and auth migrations, both have
`execute` revoked from `public` and `anon`. They are not granted to
`authenticated` either: unlike `is_active_user()`, neither is referenced from an
RLS policy, so no client role needs to call them. A client that could call
`notify_admins` directly could spam every admin with arbitrary text.

## Trigger conditions

| Table | Fires when |
|---|---|
| `topup_requests` | `after update of status`, `old.status = 'pending'` and `new.status` is `'approved'` or `'rejected'` |
| `topup_requests` | `after insert`, `new.status = 'pending'` |
| `profiles` | `after insert`, `new.approval_status = 'pending'` |
| `orders` | `after update of status`, `new.status = 'needs_review'` and `old.status is distinct from 'needs_review'` |

Each is guarded so a no-op update or a repeated write cannot produce a duplicate
notification. The `is distinct from` form on `orders` matters: `verify-payment`
can write `needs_review` more than once for the same order.

## Delivery

An `after insert` trigger on `notifications` calls `pg_net.http_post` against the
`send-push` Edge Function with the new row's id.

**The trigger body must not be able to fail the transaction.** A raising trigger
would roll back the statement it is attached to, which here means a push problem
could prevent a top-up from being approved — money blocked by a notification bug.
The `http_post` call is therefore wrapped in an exception handler that swallows
any error. `pg_net` is asynchronous by design, which already helps, but the
guarantee must not rest on that alone.

`send-push` runs under the service role. It reads the notification, loads that
user's subscriptions, and sends each one a Web Push payload signed with the VAPID
keypair. A `404` or `410` means the browser is gone, and that subscription row is
deleted. Any other failure is logged and ignored.

Requires `create extension if not exists pg_net;` — available on Supabase but not
currently used anywhere in this project.

## Service worker

`public/sw.js`, served as a plain static file. No `vite-plugin-pwa`, no Workbox —
neither is needed for push, and both would introduce a build step and caching
behaviour this change does not want.

It handles exactly two events:
- `push` — show the notification with its title, body and icon
- `notificationclick` — focus an existing window if one is open, otherwise open
  the notification's `link`. The link is resolved against the worker's own origin
  and anything that lands elsewhere falls back to `/notifications`.

**It has no `fetch` handler**, so the app's loading behaviour is unchanged.

## Permission

Permission is requested from a toggle in Settings — the customer's and the
admin's — and never on page load. iOS requires the request to come from a user
gesture, and prompting cold is the reliable way to get denied permanently.

The toggle renders one of four states, determined by capability detection in
`src/lib/push.ts`:

| Condition | UI |
|---|---|
| `serviceWorker` and `PushManager` present, permission `default` | "Turn on notifications" |
| Permission `granted`, subscription exists | "On" with a way to turn it off |
| Permission `denied` | An explanation that it must be re-enabled in browser settings — the API cannot re-prompt |
| iOS, not running standalone | "Add SnackLabs to your Home Screen to turn on notifications" |

That last row is a requirement, not a nicety. On iOS, web push is unavailable in
a Safari tab at any version, so a working-looking button there would simply fail.

A push subscription identifies a browser, not a person, and an office pantry
shares devices. So signing out removes this browser's subscription first
(`src/lib/signOut.ts`), while the session still exists to authorise the delete.
That teardown is best-effort and bounded: if it fails or stalls, sign-out still
happens. Separately, `claim_push_subscription` hands an endpoint to whoever turns
notifications on next, and refuses an account's 21st subscription.

Known iOS constraints, documented so they are not rediscovered as bugs:
- iOS/iPadOS 16.4 or later
- Must be launched from the Home Screen
- Deleting and re-adding the icon loses the subscription silently; the person
  must turn notifications on again

## In-app

`NotificationsContext` opens a Supabase Realtime subscription on the signed-in
user's `notifications` rows and maintains the unread count.

One `/notifications` page serves both audiences — the rows are already scoped per
user, so an admin sees their admin alerts and a customer sees their top-up
results, with no role branching. Rows are marked read as they are seen.

Alerts is a persistent navigation item in both layouts, in the same place and
with the same label ("Alerts", a bell icon), linking to `/notifications`. This
replaced an earlier plan of a customer bottom-nav tab but an admin header bell:
the owner wanted one consistent location rather than one per layout.
- `src/pages/CustomerLayout.tsx` — a tab in the bottom nav, at every width
- `src/pages/admin/AdminLayout.tsx` — an item in the desktop sidebar and in the
  mobile bottom bar. Alerts takes the slot the bar's Store tab gave up when the
  header gained a Visit store link; Sales and Top-ups stay out of the mobile bar.

Both layouts read the same unread count from `NotificationsContext` and draw it
through one shared component, `src/components/NavItemIcon.tsx`, so the badge looks
identical everywhere. The count is hidden from assistive technology on the badge
itself and carried in the link's accessible name instead ("Alerts, 3 unread"),
built by `unreadLabel` in `src/lib/notifications.ts`.

`/notifications` is a single route under the customer layout, so an admin who
follows Alerts lands in the customer shell rather than the admin one. This follows
directly from the owner's instruction that both audiences use the same link.

This layer needs no permission, no service worker and no particular OS version,
so it works everywhere — including the iPhone that never installed the app. It is
what makes a dropped push a delayed notification rather than a lost one.

## Error handling

| Condition | Behaviour |
|---|---|
| Push send fails | Logged in `send-push`; the notification row is untouched and still unread |
| Subscription returns 404/410 | That `push_subscriptions` row is deleted |
| `pg_net` unavailable or erroring | Swallowed by the trigger's exception handler; the underlying action still commits |
| Permission denied | In-app notifications continue; the toggle explains how to re-enable |
| Realtime drops | The unread count refetches on reconnect and on route change |

## Testing

**pgTAP** (`supabase/tests/notifications.test.sql`):
- a user cannot read, insert, update or delete another user's notifications
- a user can mark their own notification read
- approving a top-up notifies exactly the requesting customer, once
- rejecting a top-up notifies exactly the requesting customer, once
- a new pending top-up notifies every admin and nobody else
- a new pending profile notifies every admin
- an order entering `needs_review` notifies every admin
- `notify_admins` excludes the acting admin
- a second write of the same status produces no second notification
- a no-op update produces no notification
- `push_subscriptions` RLS: a user cannot read or delete another user's rows

**vitest**: capability detection in `src/lib/push.ts` (iOS-standalone, missing
`PushManager`, denied permission), and any pure formatting helper.

**Manual, on a real device**: install to Home Screen on iOS 16.4+, grant
permission, approve a top-up from another account, confirm the notification
arrives with the app closed and opens `/wallet`.

## Environment work the owner must do

- Generate a VAPID keypair. The public half goes in `.env` as
  `VITE_VAPID_PUBLIC_KEY`; the private half is set with
  `supabase secrets set VAPID_PRIVATE_KEY=...`, which cannot be done from a
  migration.
- `supabase functions deploy send-push`.
- Confirm `pg_net` is enabled on the hosted project.

## Out of scope

- Notification preferences per event type
- Digest or batching
- Email or SMS
- Offline caching, background sync, or any other PWA capability
- Notifications for events not in the table above
