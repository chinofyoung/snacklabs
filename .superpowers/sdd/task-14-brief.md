### Task 14: Visual polish + full mobile E2E pass

**Files:**
- Modify: any `src/**` styling that needs it (no logic changes), `src/index.css`
- Create: `docs/screenshots/*.png`

**Interfaces:**
- Consumes: everything.
- Produces: a polished, consistent UI and a verified end-to-end flow.

- [ ] **Step 1: Design pass**

Invoke the `frontend-design:frontend-design` skill and apply its guidance across the app: consistent type scale, the brand orange used with restraint (primary actions only), consistent card radius/shadow, focus states, empty states, and a distinctive login screen. Do not change behavior, routes, or data flow. Do not introduce new fonts from external CDNs unless self-hosted.

- [ ] **Step 2: Mobile E2E checklist (375px viewport)**

Using the preview/browser tooling on the dev server, verify each and capture screenshots into `docs/screenshots/`:

1. `login.png` — login screen.
2. `store.png` — store grid, search + chips work, out-of-stock greyed.
3. `cart.png` — steppers clamp at stock, total correct.
4. `pay.png` — QR + amount; upload button states cycle.
5. `orders.png` — statuses render with correct badge colors.
6. Admin at 375px: bottom tabs; at 1280px: sidebar (`admin-mobile.png`, `admin-desktop.png`).
7. `restock-review.png` — AI restock review screen.

- [ ] **Step 3: Final verification gate**

Run: `npm run test` → all pass. Run: `npm run build` → succeeds with no TS errors. Confirm both Edge Functions are deployed (`supabase functions list`). Report any items from the checklist that could not be verified (e.g., real-payment pass path requires a genuine screenshot) rather than claiming them done.
