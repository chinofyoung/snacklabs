# Task 30 — Admin User Management

## Step 1 — Migration: protect_last_admin

Created `supabase/migrations/20260703084355_protect_last_admin.sql`:
- `public.protect_last_admin()` trigger function (security definer, `search_path = public`) that raises `Cannot remove the last admin` when an update would flip `is_admin` from `true` to `false` and the resulting admin count would be 0.
- `before update` trigger `protect_last_admin` on `public.profiles` calling the function.

Applied via `supabase db query --linked --file supabase/migrations/20260703084355_protect_last_admin.sql`, then tracked with:
```sql
insert into supabase_migrations.schema_migrations (version, name) values ('20260703084355', 'protect_last_admin');
```

Verification:
```sql
select tgname from pg_trigger where tgname='protect_last_admin';
-- returns: protect_last_admin
```
`select version from supabase_migrations.schema_migrations order by version;` confirms `20260703084355` is now the latest tracked migration, after the prior six.

The real admin (chino.young@goabroad.com) was NOT demoted or otherwise touched during verification — only `pg_trigger`/`schema_migrations` metadata was queried.

## Step 2 — Users page (src/pages/admin/Users.tsx, new)

- Loads all profiles: `supabase.from('profiles').select('id, email, full_name, is_admin, created_at').order('created_at')`.
- Uses `useAuth()` (`profile.id`) to detect and label the current user's row with a "You" chip.
- Client-side search box (name/email) above the list.
- Each row: name (falls back to email if `full_name` is empty), email, admin badge (lucide `ShieldCheck` + "Admin") when applicable.
- Actions: "Make admin" (dark filled button) for non-admins; "Revoke admin" (subtle red text/hover button) for admins. Both call `.update({ is_admin }).eq('id', id)`, destructure `{ error }`, surface `error.message` in a visible `role="alert"` paragraph (this is how the last-admin trigger's exception message reaches the UI), and refresh the list (`load()`) on success.
- Per-row `busyId` state disables the acting button and shows "Working…" to prevent double-clicks; no special-casing of "last admin" client-side — relies on the DB trigger as instructed.
- Styling matches existing admin pages (Items.tsx/Settings.tsx): `rounded-lg bg-surface-raised p-3 shadow-card` rows, `font-display` heading, same button/badge conventions.

## Step 3 — Nav (src/pages/admin/AdminLayout.tsx)

Added `Users` to the lucide-react import and to the `NAV` array between Orders and Settings:
```
{ to: '/admin/users', label: 'Users', icon: Users, end: false }
```
Final nav order: Dashboard, Items, Orders, Users, Settings. Back-to-store link and mobile bottom nav (which reuses `NAV`) unchanged otherwise.

## Step 4 — Route (src/App.tsx)

Imported `Users` from `./pages/admin/Users` and added `<Route path="users" element={<Users />} />` under the `/admin` route, alongside the existing Dashboard/Items/Settings/Orders/Restock routes.

## Gate

- `npm run test` → 4 test files, 25/25 passed, no test changes needed.
- `npm run build` → `tsc -b && vite build` completed cleanly (only the pre-existing informational chunk-size-warning, no errors).
- Trigger existence re-confirmed via `pg_trigger` query above without demoting any admin.

## Fix round 1 — review findings (src/pages/admin/Users.tsx)

1. **load() swallowed fetch errors (Important)**: `load()` now destructures `{ data, error: fetchErr }` instead of just `{ data }`. On error, it calls `setError(fetchErr.message)` and returns without touching `users`, so a failed fetch no longer silently clobbers the list with `[]`/renders "No users found". On success it clears the error (`setError(null)`) then sets `users`. `load` is still the same stable arrow function used by the initial `useEffect` and by `setAdmin` after a successful update.
2. **No confirm before revoking admin (Minor UX safety)**: `setAdmin(user, isAdmin)` now starts with `if (!isAdmin && !confirm(\`Revoke admin access for ${user.full_name || user.email}?\`)) return`, guarding only the revoke path (demote to non-admin); promoting to admin still proceeds with no prompt. The full `user: UserRow` object was already passed into `setAdmin`, so `full_name`/`email` were available without any signature change.

All other behavior preserved: RLS-based `.update({ is_admin }).eq('id', user.id)`, per-row `busyId` busy state, "You" chip for the current user, `load()` refresh after a successful update, and error surfacing via the existing `role="alert"` paragraph.

### Gate
- `npm run test` → 4 test files, 25/25 passed.
- `npm run build` → `tsc -b && vite build` completed cleanly (only the pre-existing informational chunk-size-warning, no errors).
