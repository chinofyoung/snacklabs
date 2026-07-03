# Task 3 Report — Auth: Google sign-in, AuthContext, route guards, app shell routing

Status: DONE

## What was implemented

Implemented the brief (`.superpowers/sdd/task-3-brief.md`) Steps 1–4 exactly, with the two controller integration notes applied.

1. **`src/context/AuthContext.tsx`** (created) — verbatim from brief Step 1. Exports `Profile` interface, `AuthProvider`, and `useAuth()` returning `{ session, profile, loading, signOut }`. Subscribes to `supabase.auth.onAuthStateChange`, fetches the `profiles` row when a session appears, clears profile on sign-out.
2. **`src/pages/Login.tsx`** (created) — verbatim from brief Step 2. Google OAuth via `supabase.auth.signInWithOAuth` with `redirectTo: window.location.origin`.
3. **`src/components/guards.tsx`** (created) — verbatim from brief Step 3. `RequireAuth` (splash while loading, redirect to `/login` when unauthenticated) and `RequireAdmin` (additionally redirects non-admins to `/`).
4. **`src/main.tsx`** (modified) — provider nesting per integration note 1: `<StrictMode><BrowserRouter><AuthProvider><CartProvider><App /></CartProvider></AuthProvider></BrowserRouter></StrictMode>`. Existing `CartProvider` (Task 4) preserved.
5. **`src/App.tsx`** (replaced entirely) — Vite template boilerplate removed; now the brief Step 4 route shell: `/login` → `Login`, `/` → `RequireAuth` + Store placeholder, `/admin/*` → `RequireAdmin` + Admin placeholder.

## Verification results

- `npm run test`: **PASS** — Test Files 2 passed (2), Tests 8 passed (8), duration 136ms.
- `npm run build` (`tsc -b && vite build`): **PASS** — 122 modules transformed, built in 142ms, no TypeScript errors.
- `npm run dev`: server ready in 183ms at http://localhost:5173/; `curl http://localhost:5173/login` returned **HTTP 200** with the app HTML shell. Dev server killed afterward.
- No live sign-in attempted (Task 2 tables pending, per instructions). No git commands run.

## Files changed (absolute paths)

- /Users/chinoyoung/snacklabs/src/context/AuthContext.tsx (new)
- /Users/chinoyoung/snacklabs/src/pages/Login.tsx (new)
- /Users/chinoyoung/snacklabs/src/components/guards.tsx (new)
- /Users/chinoyoung/snacklabs/src/App.tsx (rewritten)
- /Users/chinoyoung/snacklabs/src/main.tsx (rewritten)

## Self-review findings

- The three new files match the brief verbatim (including the `react-refresh/only-export-components` eslint-disable on `useAuth`).
- main.tsx nesting matches integration note 1 exactly; `import App from './App'` per the brief's snippet (extension-less, equivalent to the previous `./App.tsx`).
- App.tsx matches the brief's route structure; later tasks can swap the `Placeholder` elements.
- Old `src/assets` images (react.svg, vite.svg, hero.png) are no longer referenced by App.tsx but were left in place — harmless, and cleanup wasn't in scope.

## Concerns

- **Profile fetch depends on Task 2**: until the `profiles` table + trigger exist, a signed-in user's profile query returns null; `RequireAdmin` would redirect to `/`, and `loading` still resolves (the `.then` runs with `data: null`). Expected and fine for now, but live verification must happen after Task 2.
- Brief's Login/guard classes use the `ink-*` Tailwind palette from Task 1's config; build CSS compiled cleanly so the palette resolves.
- No unit tests were added for auth (brief specified none); existing suite (8 tests) unaffected.

## Fix round 1

**Finding**: Stale-response race in AuthContext profile fetch. The second `useEffect` (keyed on `session`) started a `supabase.from('profiles').select('*').eq('id', session.user.id).single()` fetch with no cleanup. If `session` changed twice quickly, an older in-flight response could resolve last and overwrite `profile`/`loading` with stale data.

**Fix applied**: Added ignore flag with cleanup function in `src/context/AuthContext.tsx` (lines 41–48):
```tsx
useEffect(() => {
  if (!session) return
  let ignore = false
  supabase.from('profiles').select('*').eq('id', session.user.id).single()
    .then(({ data }) => {
      if (ignore) return
      setProfile(data as Profile | null)
      setLoading(false)
    })
  return () => { ignore = true }
}, [session])
```

When the effect re-runs or unmounts, `ignore` is set to true, causing any pending resolve to skip the state update.

**Test results**: `npm run test` — Test Files 2 passed (2), Tests 8 passed (8), duration 245ms.
**Build results**: `npm run build` — 122 modules transformed, built in 150ms, no errors.
