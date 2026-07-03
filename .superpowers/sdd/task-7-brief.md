### Task 7: Payment verdict logic (TDD) + `verify-payment` Edge Function

**Files:**
- Create: `supabase/functions/_shared/verdict.ts`, `supabase/functions/verify-payment/index.ts`
- Test: `supabase/functions/_shared/verdict.test.ts`

**Interfaces:**
- Consumes: DB functions from Task 2 (`confirm_order`), `orders`/`payment_methods` tables, `receipts` bucket.
- Produces:
  - `decideOrderStatus(v: AiVerdictResult, orderTotal: number, refAlreadyUsed: boolean): 'paid' | 'needs_review'` in `_shared/verdict.ts` (pure — no Deno APIs, so Vitest can run it).
  - `AiVerdictResult` type identical in shape to the frontend `AiVerdict` (Task 4).
  - Edge Function `verify-payment`: `POST` body `{ order_id: string, receipt_path: string }`, requires user JWT. Responds `{ status: 'paid' | 'needs_review' }` or `{ error: string }` (4xx/5xx). Frontend (Task 8) calls it via `supabase.functions.invoke('verify-payment', { body })`.

- [ ] **Step 1: Write failing verdict tests**

`supabase/functions/_shared/verdict.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { decideOrderStatus, type AiVerdictResult } from './verdict'

const v = (over: Partial<AiVerdictResult> = {}): AiVerdictResult => ({
  verdict: 'pass',
  extracted: { amount: 60.5, recipient: 'Snack Labs', reference: 'REF123', timestamp: '2026-07-02' },
  reason: 'ok',
  ...over,
})

describe('decideOrderStatus', () => {
  it('pays when AI passes and amount matches', () => {
    expect(decideOrderStatus(v(), 60.5, false)).toBe('paid')
  })
  it('needs review when AI says fail or unsure', () => {
    expect(decideOrderStatus(v({ verdict: 'fail' }), 60.5, false)).toBe('needs_review')
    expect(decideOrderStatus(v({ verdict: 'unsure' }), 60.5, false)).toBe('needs_review')
  })
  it('needs review when amount mismatches or is missing', () => {
    expect(decideOrderStatus(v({ extracted: { ...v().extracted, amount: 60 } }), 60.5, false)).toBe('needs_review')
    expect(decideOrderStatus(v({ extracted: { ...v().extracted, amount: null } }), 60.5, false)).toBe('needs_review')
  })
  it('tolerates sub-centavo float noise', () => {
    expect(decideOrderStatus(v({ extracted: { ...v().extracted, amount: 60.500001 } }), 60.5, false)).toBe('paid')
  })
  it('needs review when the reference was already used', () => {
    expect(decideOrderStatus(v(), 60.5, true)).toBe('needs_review')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test` → FAIL: cannot find `./verdict`.

- [ ] **Step 3: Implement `supabase/functions/_shared/verdict.ts`**

```ts
export interface AiVerdictResult {
  verdict: 'pass' | 'fail' | 'unsure'
  extracted: {
    amount: number | null
    recipient: string | null
    reference: string | null
    timestamp: string | null
  }
  reason: string
}

export function decideOrderStatus(
  v: AiVerdictResult,
  orderTotal: number,
  refAlreadyUsed: boolean,
): 'paid' | 'needs_review' {
  if (refAlreadyUsed) return 'needs_review'
  if (v.verdict !== 'pass') return 'needs_review'
  if (v.extracted.amount === null) return 'needs_review'
  if (Math.abs(v.extracted.amount - orderTotal) > 0.009) return 'needs_review'
  return 'paid'
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test` → PASS.

- [ ] **Step 5: Implement the Edge Function**

`supabase/functions/verify-payment/index.ts`:

```ts
import { createClient } from 'npm:@supabase/supabase-js@2'
import Anthropic from 'npm:@anthropic-ai/sdk'
import { decideOrderStatus, type AiVerdictResult } from '../_shared/verdict.ts'

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail', 'unsure'] },
    extracted: {
      type: 'object',
      properties: {
        amount: { type: ['number', 'null'] },
        recipient: { type: ['string', 'null'] },
        reference: { type: ['string', 'null'] },
        timestamp: { type: ['string', 'null'] },
      },
      required: ['amount', 'recipient', 'reference', 'timestamp'],
      additionalProperties: false,
    },
    reason: { type: 'string' },
  },
  required: ['verdict', 'extracted', 'reason'],
  additionalProperties: false,
} as const

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  const { order_id, receipt_path } = await req.json().catch(() => ({}))
  if (!order_id || !receipt_path) return json({ error: 'order_id and receipt_path required' }, 400)

  // Client scoped to the calling user (validates JWT + ownership via RLS)
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } },
  )
  // Service client for privileged updates
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const { data: order, error: orderErr } = await userClient
    .from('orders').select('*').eq('id', order_id).single()
  if (orderErr || !order) return json({ error: 'order not found' }, 404)
  if (!['awaiting_payment', 'needs_review'].includes(order.status)) {
    return json({ error: `order is ${order.status}` }, 409)
  }

  const { data: method } = await admin
    .from('payment_methods').select('*').eq('id', order.payment_method_id).single()

  // Mark verifying + attach receipt
  await admin.from('orders')
    .update({ status: 'verifying', receipt_image_url: receipt_path })
    .eq('id', order_id)

  const parkForReview = async (reason: string, verdict: AiVerdictResult | null) => {
    await admin.from('orders')
      .update({ status: 'needs_review', ai_verdict: verdict ?? { verdict: 'unsure', extracted: { amount: null, recipient: null, reference: null, timestamp: null }, reason } })
      .eq('id', order_id)
    return json({ status: 'needs_review' })
  }

  // Download receipt image
  const { data: blob, error: dlErr } = await admin.storage.from('receipts').download(receipt_path)
  if (dlErr || !blob) return parkForReview('receipt image could not be read', null)
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let b64 = ''
  const CHUNK = 8192
  for (let i = 0; i < bytes.length; i += CHUNK) {
    b64 += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  b64 = btoa(b64)
  const mediaType = blob.type === 'image/png' ? 'image/png' : 'image/jpeg'

  // Ask Claude to read the receipt
  let verdict: AiVerdictResult
  try {
    const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY')! })
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 2048,
      output_config: { format: { type: 'json_schema', schema: VERDICT_SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
          {
            type: 'text',
            text: [
              'You are verifying a payment confirmation screenshot for an office pantry purchase.',
              `Expected amount: PHP ${order.total}.`,
              `Expected recipient: "${method?.account_name ?? 'unknown'}" via ${method?.label ?? 'unknown'} (account number ending in "${(method?.account_number ?? '').slice(-4)}").`,
              '',
              'Rubric:',
              '- verdict "pass" ONLY if this is clearly a genuine payment success screen, the amount exactly matches, and the recipient plausibly matches.',
              '- verdict "fail" if the amount or recipient clearly does not match, or the image is not a payment confirmation.',
              '- verdict "unsure" if anything is ambiguous, cropped, edited-looking, or unreadable.',
              'Extract the paid amount as a number, the recipient name, the reference/transaction number, and the payment timestamp. Use null for anything not visible.',
              'Explain briefly in "reason".',
            ].join('\n'),
          },
        ],
      }],
    })
    const text = response.content.find((b) => b.type === 'text')
    if (!text || text.type !== 'text') throw new Error('no text block')
    verdict = JSON.parse(text.text) as AiVerdictResult
  } catch (e) {
    return parkForReview(`AI verification unavailable: ${e instanceof Error ? e.message : e}`, null)
  }

  // Reference reuse check (blocks screenshot replay)
  let refAlreadyUsed = false
  if (verdict.extracted.reference) {
    const { count } = await admin
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'paid')
      .neq('id', order_id)
      .eq('ai_verdict->extracted->>reference', verdict.extracted.reference)
    refAlreadyUsed = (count ?? 0) > 0
  }

  const decision = decideOrderStatus(verdict, Number(order.total), refAlreadyUsed)

  if (decision === 'paid') {
    const { error: confirmErr } = await admin.rpc('confirm_order', {
      p_order_id: order_id,
      p_verdict: verdict,
    })
    if (confirmErr) return parkForReview(`stock confirmation failed: ${confirmErr.message}`, verdict)
    return json({ status: 'paid' })
  }

  if (refAlreadyUsed) verdict.reason = `Reference number already used on another paid order. ${verdict.reason}`
  return parkForReview(verdict.reason, verdict)
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
```

Note: Vitest must not pick up `index.ts` (it imports Deno/npm specifiers) — the vitest `include` from Task 1 only matches `_shared/`, and `verdict.ts` is dependency-free. The `../_shared/verdict.ts` import uses an explicit `.ts` extension (required by Deno).

- [ ] **Step 6: Deploy and verify**

```bash
supabase functions deploy verify-payment
supabase secrets list   # confirm ANTHROPIC_API_KEY is set; if not, STOP and ask the user
```

Expected: deploy succeeds. Full end-to-end verification happens in Task 8 (needs the upload UI). Sanity check now: calling it without auth returns 401:
`curl -s -X POST https://<project-ref>.supabase.co/functions/v1/verify-payment` → 401.

---

