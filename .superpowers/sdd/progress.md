Task 1: complete (no git — file-based review; review clean)
  Minors deferred to final review: package.json name/index.html title = "scaffold"; App.tsx keeps Vite boilerplate (replaced in Task 3)
Task 4: complete (fix round 1: out-of-stock add guard + Array.isArray localStorage guard; re-review approved)
  Minor deferred: setQty clamp-to-0 leaves qty:0 line when stock drops to 0 for an in-cart item (pre-existing per plan spec); no CartContext-level tests
Task 3: complete (fix round 1: ignore-flag on profile fetch; re-review approved)
  Minors deferred: no error-path logging on profile fetch; dead src/assets files
Supabase: CLI 2.109.0 at ~/.local/bin; project aztgvfrayjbhtxfvsram linked; .env.local populated
Deferred live verifications (need user at browser): Google sign-in test; admin flag flip after first sign-in
Task 2: complete (SQL verbatim; review Needs-fixes resolved by controller: /opt/homebrew/bin/supabase db push --dry-run = in sync + full object inventory matches [6 tables, 5 fns, 19 policies, trigger, 4 buckets, RLS x6])
  Minors deferred (plan-mandated): search_path=public on SECURITY DEFINER fns; create_order validates but doesn't reserve stock
  Working CLI: /opt/homebrew/bin/supabase (the ~/.local/bin one is a shim needing supabase-go — do not use)
  Seed data: 3 items + 1 GCash payment method inserted
Task 5: complete (fix round 1: fetch error state; re-review approved)
  Deferred to final review: bare .then(({data})) fetch pattern (no error handling) recurs in plan code for later pages — triage globally
User signed in OK (Google OAuth configured); chino.young@goabroad.com is_admin=true
Task 6: complete (review clean, approved first pass)
  Minors deferred: Pay.tsx fetches ignore error field (inherited pattern); 'insufficient stock' substring match fragile if SQL wording changes
PENDING USER ACTION: ANTHROPIC_API_KEY secret not yet set (user will add later via: supabase secrets set ANTHROPIC_API_KEY=<key>) — AI verification/restock will park to needs_review / error visibly until then
Task 7: complete (fix round 1: fail-closed ref-reuse check + receipt_path owner binding; redeployed; re-review approved)
  Controller-resolved ⚠️: confirm_order status-gate under FOR UPDATE prevents TOCTOU double-confirm; verdict persisted via coalesce; type parity AiVerdict==AiVerdictResult
  Minors deferred: media-type fallback JPEG for non-PNG; unchecked 'verifying' update result
Task 8: complete (fix round 2: verifying-status render branch; re-review via controller grep + fixer test evidence)
  Minors deferred: ImageBitmap not .close()d; `void data` lint silencer
Task 9: complete (review clean first pass)
  Minors deferred: dashboard lacks loading/error states; sibling pages pass raw total into formatPeso without Number() coercion (likely benign — PostgREST serializes numeric as JSON number)
Task 10: complete (fix round 1: stock-update error resync, pre-upload validation, deactivate error surfacing; re-review approved; fixer omitted report section — controller appended)
  Minors deferred: orphaned storage upload if DB save fails after upload
Task 11: complete (review clean first pass; Items-page lessons pre-applied as controller deviations)
  Minors deferred: duplicate error render when modal open; error message tone inconsistency
Task 12: complete (fix round 1: reject error alert + signed-URL error surfacing; controller-verified via grep + tests; fixer omitted report section again — controller appended)
Task 13: complete (review clean first pass; analyze-shelf deployed, 401 sanity OK)
  Minors deferred: discard path leaves sessions pending_review; createObjectURL leak on repeated scans; category hardcoded 'snacks' in apply payload
Task 15: complete (emoji→lucide-react across 14 files; 13/13 tests, clean build; live-verified in browser)
LIVE E2E (browser, in progress): store/cart/order/QR verified working; ₱95 order created (58b7ad5e). BUG FOUND: verify-payment + analyze-shelf missing CORS preflight → browser invoke() fails ("Failed to send a request to the Edge Function"). Task 16 fixing.
Task 16: complete (CORS added to both Edge Functions; live preflight HTTP 200 + allow-origin verified via curl; redeployed; 13/13 tests)
Task 17 (in progress): AI usage cost tracking, FX rate ₱58.50/$1 (user-chosen)
LIVE E2E HAPPY PATH VERIFIED: uploaded generated GCash receipt → "Payment verified — enjoy!" → order 58b7ad5e paid → stock decremented (Coke 6→4, Piattos 10→9). CORS fix + Claude vision verification + confirm_order all confirmed working in real browser.
Task 18 (in progress): "Back to store" button on Pay terminal states (user-requested UX gap).
Task 17: complete (ai_usage table + pricing module TDD [16/16 tests] + both functions log cost + dashboard card; redeployed; FX ₱58.50/$1)
Task 18: back button done; countdown in progress
Task 18: complete (back button + countdown; live-verified: paid screen shows button + "Returning to store in N…", auto-redirected to store at 0)
LIVE-VERIFIED cost card renders (₱0.00/0 calls/₱58.50/$1 label) — will populate on next verification (paid order d0e3614e predated cost-logging deploy).
Orders in DB: d0e3614e paid ₱95 (stock decremented); 58b7ad5e + 056979b4 orphaned awaiting_payment test orders.
REMAINING: final whole-branch review; optional live cost-number demo (needs 1 more receipt upload post-Task17).
Task 19: complete (pagination 10 + Load more on both order lists; LIVE-VERIFIED: admin Orders showed 10 + Load more → appended 5 → button hid; seeded 12 test orders then deleted all 12 by explicit id; 3 real orders remain)
FINAL WHOLE-BRANCH REVIEW (opus): READY TO MERGE. No Critical/Important. Verified: RLS on all tables + storage; no client path to paid/stock/confirm_order/apply_restock; @goabroad enforced server-side; Anthropic key server-only; receipt owner-binding + ref-reuse defense; CORS on both fns; pricing math + FX matches; pagination uniform. 3 Minors (all pre-noted): restock 'discarded' never written; restock category hardcoded 'snacks'; verifying-retry is admin-only.
Task 20: complete (admin "Back to store" link — desktop sidebar bottom + mobile bottom-bar Store item; 16/16, clean build)
Task 21 (in progress): admin delete-all-transactions — delete_all_orders() admin-gated RPC (preserves ai_usage) + type-DELETE confirm modal in AdminOrders.
Netlify: added public/_redirects (SPA fallback) — NEEDS REDEPLOY; localhost:3000 redirect = Supabase Site URL still default (user fixing in dashboard: Site URL + Redirect URLs → gapsnacklabs.netlify.app). Env vars confirmed baked into deployed bundle.
Task 21: complete (delete_all_orders() admin-gated RPC + type-DELETE modal; REVIEW APPROVED — auth gate correct under security-definer, FK detach-before-delete correct, no UI bypass, function never executed during build. Minor deferred: no explicit REVOKE EXECUTE hardening (relies on in-function is_admin, consistent with confirm_order/apply_restock); unused return count.)
Live UI check of delete-all modal pending: browser session expired (redirected to /login) — needs user re-login.
Task 22: complete (surface Edge Function {error} body in Restock + Pay instead of generic invoke message; 16/16, clean build).
RESTOCK FAILURE DIAGNOSIS: code proven working — session fd588599 at 03:54 succeeded (3 detections, applied, logged ₱1.22 ai_usage). Two later uploads (04:02) failed at the Anthropic call (502, no session/cost row). No code change between. → environmental: almost certainly Anthropic API credit balance/spend-limit/rate-limit on the user's key. Task 22 will surface exact message on next retry.
