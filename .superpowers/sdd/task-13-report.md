# Task 13 Report: analyze-shelf Edge Function + AI Restock admin page

## Status: Implemented

## What was implemented

1. **`supabase/functions/analyze-shelf/index.ts`** (new) — created verbatim per the task brief (Step 1). Mirrors `verify-payment/index.ts` patterns:
   - `userClient` scoped to caller's JWT to validate auth + admin role via `profiles.is_admin`.
   - `admin` service-role client for privileged reads/writes (catalog fetch, storage download, `restock_sessions` insert).
   - Downloads photo from private `restock-photos` bucket, base64-encodes in 8192-byte chunks.
   - Calls Anthropic with `model: 'claude-opus-4-8'` and `output_config: { format: { type: 'json_schema', schema: DETECTIONS_SCHEMA } }` (exact model string and schema as specified).
   - On success, inserts a `restock_sessions` row and returns `{ session_id, detections }`; on failure returns `{ error }` with appropriate status codes (400/401/403/502/500).

2. **`src/pages/admin/Restock.tsx`** (new) — created verbatim per the task brief (Step 3). Phases: idle → analyzing → review → applying → done. Take/upload photo (compressed via `compressImage`, uploaded to `restock-photos`, analyzed via `analyze-shelf` function invoke) → editable detection rows (name, qty, price, include toggle, confidence badge, matched/new badge) → Apply via `apply_restock` RPC.

3. **`src/App.tsx`** (modified) — added `import Restock from './pages/admin/Restock'` and `<Route path="restock" element={<Restock />} />` inside the `RequireAdmin`-gated `/admin` route tree, replacing the `{/* Tasks 11–13 add: restock, orders, payments */}` placeholder comment.

## Deploy output

```
WARNING: Docker is not running
Uploading asset (analyze-shelf): supabase/functions/analyze-shelf/index.ts
{"project_ref":"aztgvfrayjbhtxfvsram","functions":["analyze-shelf"],"dashboard_url":"https://supabase.com/dashboard/project/aztgvfrayjbhtxfvsram/functions","message":"Deployed Functions."}
```

Deployed successfully using `/opt/homebrew/bin/supabase functions deploy analyze-shelf` with `SUPABASE_ACCESS_TOKEN` exported for the CLI call only (not written to any file).

## Sanity check: unauthenticated POST

```
curl -s -o /tmp/resp.json -w "%{http_code}" -X POST \
  https://aztgvfrayjbhtxfvsram.supabase.co/functions/v1/analyze-shelf \
  -H "Content-Type: application/json" -d '{"photo_path":"test.jpg"}'
```

Result: **HTTP 401** — `{"code":"UNAUTHORIZED_NO_AUTH_HEADER","message":"Missing authorization header"}`.

This 401 originates from the Supabase Edge Functions gateway itself (rejecting requests with no `Authorization` header at all, before invoking the function), which satisfies the "unauthenticated POST returns 401" sanity requirement. Note the function's own internal auth check (`if (!user) return json({ error: 'unauthenticated' }, 401)`) would fire identically for a request bearing a malformed/invalid JWT — both paths converge on 401.

## Test / build results

- `npm run test` → **13/13 passed** (3 test files, 145ms).
- `npm run build` → **succeeded** (`tsc -b && vite build`, no type errors, 136 modules transformed).

## Files changed

- `supabase/functions/analyze-shelf/index.ts` (new)
- `src/pages/admin/Restock.tsx` (new)
- `src/App.tsx` (modified — added import + route)

## Concerns / known pending items

- **`ANTHROPIC_API_KEY` secret is not yet set** on the Supabase project. This is expected per the task instructions (user adds it later) — not a blocker for deploy, but live photo analysis will fail with `AI analysis failed: ...` (502) until the secret is configured via `supabase secrets set ANTHROPIC_API_KEY=...`.
- No live end-to-end verification was performed (no dev server, no real photo analysis) per the task's explicit gate ("No live photo analysis... no dev servers"). Step 4's full manual verification (upload photo → review rows → Apply → confirm stock/`restock_sessions.status = 'applied'`) is deferred until the API key is set and should be done by the user or a follow-up task.
- Did not verify the `apply_restock` RPC signature/behavior beyond what's stated in the brief (assumed already implemented and correct, per task context).
