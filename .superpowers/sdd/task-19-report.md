# Task 19: Pagination for order/transaction lists

## src/pages/admin/AdminOrders.tsx

- Added `const PAGE_SIZE = 10` and state: `page`, `hasMore`, `loadingMore`.
- Replaced the `load` useCallback (which did `.limit(100)`) with `loadPage(p: number)`:
  builds the same query (`select('*, profiles(full_name, email)')`, applies the
  `filter !== 'all'` eq clause), then `.order('created_at', { ascending: false })
  .range(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE - 1)`. On `p === 0` it replaces
  `orders`; otherwise it appends. Sets `hasMore = rows.length === PAGE_SIZE`.
- The effect keyed on `loadPage` (which is keyed on `filter`) now resets to the
  first page: `useEffect(() => { setPage(0); loadPage(0) }, [loadPage])` — so
  changing the filter pill re-fetches from page 0.
- `approve` and `reject` handlers: after their existing error handling/success
  path (untouched), now call `setPage(0); await loadPage(0)` instead of `load()`,
  so the queue resets to the first page after an action.
- Added a "Load more" button after the orders list, shown only when `hasMore`,
  matching the container's `max-w-3xl`/`space-y-4` width. Disabled + shows
  "Loading…" while `loadingMore`.

## src/pages/Orders.tsx

- Added `const PAGE_SIZE = 10` and state: `page`, `hasMore`, `loadingMore`
  (existing `loading` state kept for the initial spinner).
- Replaced the one-shot `useEffect` fetch with `loadPage(p: number)`: same
  `select('*')` query, `.order('created_at', { ascending: false })
  .range(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE - 1)`. Appends/replaces the
  `orders` list the same way as AdminOrders, sets `hasMore` accordingly.
- Initial `useEffect` now calls `loadPage(0).then(() => setLoading(false))`.
- Added a "Load more" button after the orders list (inside the same
  `max-w-md mx-auto` container), shown only when `hasMore`. Status badge
  styles and the `needs_review` reason display were left untouched.

## Gate results

- `npm run test`: **16/16 passed** (4 test files), no test changes needed.
- `npm run build`: clean — `tsc -b && vite build` completed with no errors,
  output written to `dist/`.

## Concerns

- Could not exercise the pages against a live Supabase backend/browser in this
  environment (auth-gated admin/user data, and port 5173 was already occupied
  by an unrelated process I left untouched). Verification is based on gate
  results (test/build) and manual review of the diff against the spec.
