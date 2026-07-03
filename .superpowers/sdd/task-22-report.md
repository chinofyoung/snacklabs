# Task 22 — Surface real Edge Function error messages

## Problem
`supabase.functions.invoke(...)` wraps non-2xx responses in a `FunctionsHttpError`
whose `.message` is a generic string ("Edge Function returned a non-2xx status
code"). The actual reason lives in the JSON body of `error.context` (the raw
`Response`), e.g. `{ error: "AI analysis failed: <anthropic error>" }`.

## Fix
Added an `edgeErrorMessage` helper to both files that reads `err.context` as a
`Response`, clones it, parses JSON, and returns `body.error` when present —
falling back to `err.message` or a caller-supplied fallback string otherwise.

```ts
async function edgeErrorMessage(err: unknown, fallback: string): Promise<string> {
  const ctx = (err as { context?: Response } | null)?.context
  if (ctx && typeof ctx.json === 'function') {
    try {
      const body = await ctx.clone().json()
      if (body?.error) return String(body.error)
    } catch { /* not JSON */ }
  }
  return err instanceof Error ? err.message : fallback
}
```

## Call-site changes

### src/pages/admin/Restock.tsx
Added the helper after the `Phase` type declaration. In `analyze()`:

```ts
if (fnErr) throw new Error(await edgeErrorMessage(fnErr, 'Analysis failed'))
```
(previously `if (fnErr) throw fnErr`)

The existing try/catch in `analyze()` already sets `error` state from
`e.message`, so it now displays the real Edge Function reason.

### src/pages/Pay.tsx
Added the helper after the local `Phase` type declaration (inside the file,
above `PaymentStatus`). In `handleFile()`:

```ts
if (fnErr) throw new Error(await edgeErrorMessage(fnErr, 'Verification failed'))
```
(previously `if (fnErr) throw fnErr`)

The existing try/catch in `handleFile()` already sets `error` state from
`e.message`, so it now displays the real Edge Function reason.

No other logic, happy paths, or success handling were changed.

## Gate results
- `npm run test`: 16/16 passed (4 test files, 204ms)
- `npm run build`: clean (`tsc -b && vite build` succeeded, no errors)
