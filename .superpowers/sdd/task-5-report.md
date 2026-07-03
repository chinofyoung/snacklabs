# Task 5: Customer Store Page — Implementation Report

## Status: DONE

All components created and wired successfully. Test and build pass without errors.

## Files Created

1. **src/components/ItemCard.tsx** — Card component displaying individual snack items with:
   - Product image (or placeholder emoji)
   - Name, price (formatted via formatPeso)
   - Stock status and availability
   - Add to cart button, shows quantity when in cart
   - Disabled state for out-of-stock or maxed items

2. **src/components/CartBar.tsx** — Fixed bottom cart summary bar with:
   - Item count with plural handling
   - Total price (formatted)
   - Link to `/cart` (Task 6)
   - Hides when cart is empty

3. **src/pages/Store.tsx** — Main store page with:
   - Sticky header with branding, navigation links, and sign out
   - Search input for filtering items by name
   - Category filter chips (All, plus dynamically loaded categories)
   - Grid display of ItemCards for visible items
   - Loading state while fetching items
   - Empty state when no items match filters
   - CartBar component at bottom
   - Helper Chip component for category buttons

## Files Modified

- **src/App.tsx** — Replaced `/` placeholder route with `<RequireAuth><Store /></RequireAuth>` and added Store import. Kept Placeholder component and admin route as-is per instructions.

## Test & Build Results

- **Tests:** 8 passed (2 files)
- **Build:** Success. Output: 440.72 kB JS (gzipped 127.73 kB), 22.49 kB CSS (gzipped 5.09 kB)

## Implementation Details

- All components follow the brief exactly — no deviations
- Integrates with existing `useCart()` (CartContext), `useAuth()` (AuthContext), `supabase`, and `formatPeso` utility
- Search and filtering logic properly memoized to avoid unnecessary recalculations
- UI uses Tailwind classes matching the design system (brand-600, ink-900, etc.)
- ItemCard shows in-cart quantity and properly disables when stock is exhausted
- CartBar links to `/cart` (Task 6) with proper formatting

## Self-Review

- Component composition is clean and follows React best practices
- Filtering logic (search + category) works correctly with memoization
- Cart item tracking via `useCart().lines` works as expected
- Stock and UI state management properly separated
- Accessibility: semantic HTML, proper button types, placeholder text on input
- Responsive design: fixed width (max-w-md) with sticky header, 2-col grid layout

## Concerns

None. Implementation complete and verified.

## Fix Round 1

**Finding:** Silent failure on items fetch — the effect ignored the `error` field from Supabase, rendering the same "Nothing here yet." empty state as when the catalog is legitimately empty.

**Changes:**
1. Added error state: `const [error, setError] = useState<string | null>(null)` (line 15)
2. Updated effect to destructure `{ data, error }` and handle errors:
   - If error: set message "Could not load the shelf — pull to refresh or try again." and still set loading to false
   - Else: set items and loading false as before (lines 18–27)
3. Updated render conditional to check error before empty-state check:
   - When error is set, show `<p className="p-8 text-center text-red-600">{error}</p>` instead of grid/empty message (lines 57–58)

**Test & Build Results:**
- **Tests:** 8 passed (2 files) — no regressions
- **Build:** Success. Output: 440.89 kB JS (gzipped 127.79 kB), 22.49 kB CSS (gzipped 5.09 kB)
