# Task 16: CORS fix for verify-payment and analyze-shelf Edge Functions

## Bug

Frontend (http://localhost:5173) calls `supabase.functions.invoke('verify-payment', ...)` and
`('analyze-shelf', ...)`, which are cross-origin and trigger a browser CORS preflight `OPTIONS`
request. Neither function handled `OPTIONS` or returned CORS headers, so the browser blocked the
request with "Failed to send a request to the Edge Function". curl/unit tests never see this
because only browsers send preflights.

## Diff summary

Both `supabase/functions/verify-payment/index.ts` and `supabase/functions/analyze-shelf/index.ts`
received the identical three-part change:

1. Added a shared `CORS` headers constant after the imports:
   ```ts
   const CORS = {
     'Access-Control-Allow-Origin': '*',
     'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
     'Access-Control-Allow-Methods': 'POST, OPTIONS',
   }
   ```
2. Added an OPTIONS preflight short-circuit as the first line inside `Deno.serve(async (req) => { ... })`,
   before the existing method check:
   ```ts
   if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
   ```
3. Merged `CORS` into the `json()` helper's response headers so every success/error response path
   carries the headers:
   ```ts
   headers: { 'Content-Type': 'application/json', ...CORS },
   ```

No other logic was changed. Verified by re-reading both files after editing: OPTIONS is handled
first in both `Deno.serve` callbacks, and the `json()` helper in both files spreads `CORS` into its
headers.

## Deploy output

`verify-payment`:
```
WARNING: Docker is not running
Uploading asset (verify-payment): supabase/functions/verify-payment/index.ts
Uploading asset (verify-payment): supabase/functions/_shared/verdict.ts
{"project_ref":"aztgvfrayjbhtxfvsram","functions":["verify-payment"],"dashboard_url":"https://supabase.com/dashboard/project/aztgvfrayjbhtxfvsram/functions","message":"Deployed Functions."}
```

`analyze-shelf`:
```
WARNING: Docker is not running
Uploading asset (analyze-shelf): supabase/functions/analyze-shelf/index.ts
{"project_ref":"aztgvfrayjbhtxfvsram","functions":["analyze-shelf"],"dashboard_url":"https://supabase.com/dashboard/project/aztgvfrayjbhtxfvsram/functions","message":"Deployed Functions."}
```

(Docker-not-running warning is expected/benign for remote function deploys via this CLI.)

## Curl preflight verification

`verify-payment`:
```
HTTP/2 200
access-control-allow-origin: *
access-control-allow-headers: authorization, x-client-info, apikey, content-type
access-control-allow-methods: POST, OPTIONS
```

`analyze-shelf`:
```
HTTP/2 200
access-control-allow-origin: *
access-control-allow-headers: authorization, x-client-info, apikey, content-type
access-control-allow-methods: POST, OPTIONS
```

## Test / build results

- `npm run test`: 3 test files, 13/13 tests passed.
- `npm run build`: `tsc -b && vite build` completed successfully, no errors.
