# Task 20: Back to store link in AdminLayout

## Summary
Added a "Back to store" affordance to both the desktop sidebar and mobile bottom tab bar in `src/pages/admin/AdminLayout.tsx`, styled distinctly from the section nav items since it's a "leave admin" action rather than a section link.

## Changes

1. **Import**: Added `ArrowLeft` and `Store` to the existing `lucide-react` import.

2. **Desktop sidebar** (`<aside>`): Added a `Link` to `/` after the `{NAV.map(...)}` block, pushed to the bottom of the flex column with `mt-auto`:
```tsx
<Link
  to="/"
  className="mt-auto rounded-md px-3 py-2.5 text-sm font-medium transition flex items-center gap-2 text-ink-500 hover:bg-ink-900/5"
>
  <ArrowLeft className="size-6" strokeWidth={2.5} aria-hidden="true" />
  Back to store
</Link>
```

3. **Mobile bottom nav** (`<nav>`): Added a plain `Link` (not `NavLink`, no active state needed) as the first item, before `{NAV.map(...)}`:
```tsx
<Link
  to="/"
  className="flex flex-col items-center gap-0.5 text-[10px] px-2 py-1 rounded-md min-w-11 text-ink-500"
>
  <Store className="size-6" strokeWidth={2.5} aria-hidden="true" />
  Store
</Link>
```

NAV array, section NavLinks, logo link, and Outlet were left unchanged.

## Gate results
- `npm run test`: 16/16 passed (4 test files)
- `npm run build`: clean (`tsc -b && vite build` succeeded, no errors/warnings)

## Notes
Could not visually verify in the live preview — port 5173 was already occupied by a pre-existing, externally-managed node process, and per task scope no other files/processes were touched. Correctness was confirmed via source review against the spec, plus passing type-check/build/tests.
