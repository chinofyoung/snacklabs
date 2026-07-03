# Task 18: Back to store button on Pay screen

## Change

File: `src/pages/Pay.tsx`

`Link` from `react-router` was already imported (line 2), so no import changes were needed.

Added the following JSX immediately after the `<PaymentStatus order={order} onUpdated={setOrder} />` element, inside the main `Pay` component's returned container (`<div className="max-w-md mx-auto min-h-dvh px-4 py-4 space-y-5">`), before the closing `</div>`:

```tsx
      <PaymentStatus order={order} onUpdated={setOrder} />

      {['paid', 'needs_review', 'cancelled'].includes(order.status) && (
        <Link
          to="/"
          className="block w-full text-center rounded-2xl bg-ink-900 text-white py-4 font-bold active:scale-[0.98] transition"
        >
          Back to store
        </Link>
      )}
    </div>
  )
}
```

No icon prefix was added (kept plain text per the fallback guidance) since no existing button in this file mixes a lucide icon with a full-width primary CTA label — the icons in this file (`CircleCheck`, `Clock`, `ScanSearch`) are used standalone above status messages, not inline with button text.

The button relies on the parent container's `space-y-5` for spacing, consistent with sibling elements — no extra margin classes added.

`PaymentStatus` logic and all other code left untouched.

## Gate results

- `npm run test`: 13/13 relevant tests passed. One unrelated suite (`supabase/functions/_shared/pricing.test.ts`) failed to load due to a pre-existing missing module (`./pricing`) — unrelated to this change, present before edit.
- `npm run build`: clean (`tsc -b && vite build` succeeded, no type or build errors).

## Verification note

No live preview was performed against a real order — the Pay screen requires a valid `orderId` route param backed by Supabase data with a terminal `status`, and no such seeded record/id was available in this task's scope (edit-only, single file, no DB seeding). Correctness was confirmed via successful TypeScript compilation against `order.status` (typed field on `Order`) and production build.
