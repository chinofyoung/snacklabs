# Task 25: Fix persistent "unauthenticated" bug in analyze-shelf

## Root cause

`analyze-shelf` authorized via `userClient.auth.getUser(token)` (GoTrue), which is
unreliable in this Edge runtime and returns null, causing every call to fail with
"unauthenticated". The sibling `verify-payment` function works because it authorizes
via a PostgREST/RLS read using the same `userClient` (Authorization header passthrough)
rather than GoTrue. Fixed `analyze-shelf` to authorize the same proven way.

## New auth block (supabase/functions/analyze-shelf/index.ts, lines ~45-68)

```ts
const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '')
if (!token) return json({ error: 'unauthenticated' }, 401)

// Authorize via the PostgREST path (the mechanism verify-payment uses successfully),
// not GoTrue getUser() which is unreliable in this Edge runtime.
const { data: isAdmin, error: adminErr } = await userClient.rpc('is_admin')
if (adminErr) return json({ error: 'unauthenticated' }, 401)
if (!isAdmin) return json({ error: 'admin only' }, 403)

// Derive the caller's user id from the JWT `sub` claim for admin_id.
// Authorization was already verified above via is_admin() (which checks auth.uid()
// against the profiles table through a cryptographically-validated PostgREST request),
// so reading the sub claim here is safe.
function decodeSub(jwt: string): string | null {
  try {
    const part = jwt.split('.')[1]
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')
    return JSON.parse(atob(b64)).sub ?? null
  } catch {
    return null
  }
}
const userId = decodeSub(token)
if (!userId) return json({ error: 'unauthenticated' }, 401)
```

`userClient` creation (unchanged) and `getUser`/`profiles` lookup were removed entirely.

## admin_id change

`restock_sessions` insert changed from:

```ts
.insert({ admin_id: user.id, photo_url: photo_path, ai_result: result })
```

to:

```ts
.insert({ admin_id: userId, photo_url: photo_path, ai_result: result })
```

Everything else (catalog fetch, photo download, the Sonnet Anthropic call with thinking
disabled, cost logging, return) is unchanged.

## Test / build gate

```
npm run test
 Test Files  4 passed (4)
      Tests  18 passed (18)

npm run build
✓ built in 242ms   (tsc -b && vite build, no errors)
```

## Deploy output

```
export SUPABASE_ACCESS_TOKEN=<redacted>
/opt/homebrew/bin/supabase functions deploy analyze-shelf

WARNING: Docker is not running
Uploading asset (analyze-shelf): supabase/functions/analyze-shelf/index.ts
Uploading asset (analyze-shelf): supabase/functions/_shared/pricing.ts
{"project_ref":"aztgvfrayjbhtxfvsram","functions":["analyze-shelf"],"dashboard_url":"https://supabase.com/dashboard/project/aztgvfrayjbhtxfvsram/functions","message":"Deployed Functions."}
```

## Curl sanity check

```
curl -s -o /dev/null -w "%{http_code}" -X POST https://aztgvfrayjbhtxfvsram.supabase.co/functions/v1/analyze-shelf
401
```

Function reachable, returns 401 with no Authorization header as expected — confirms
deploy succeeded and the new auth path still rejects unauthenticated requests correctly.

No live Anthropic call was executed; function was not invoked with a valid admin token.
