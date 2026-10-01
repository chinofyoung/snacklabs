import { createClient } from 'npm:@supabase/supabase-js@2'
import Anthropic from 'npm:@anthropic-ai/sdk'
import { decideOrderStatus, type AiVerdictResult } from '../_shared/verdict.ts'
import { computeCost } from '../_shared/pricing.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

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
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
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
  if (!receipt_path.startsWith(`${order.user_id}/`)) {
    return json({ error: 'invalid receipt path' }, 403)
  }

  const { data: method } = await admin
    .from('payment_methods').select('*').eq('id', order.payment_method_id).single()

  // A wallet order is never verified here. It is paid by pay_order_with_wallet,
  // which flips the status and lets the sync_order_wallet trigger take the money in
  // the same transaction; the funds were already checked when an admin approved the
  // top-up, so there is nothing to re-verify. Pay.tsx only offers the receipt picker
  // for non-wallet methods, but a failed payment-method read on the client falls
  // through to it, so the guard has to be here too. Without it the order would be
  // marked 'verifying', spend an Anthropic call, and show the customer a receipt
  // step they do not need. 409 matches the status-conflict response above.
  if (method?.type === 'wallet') {
    return json({ error: 'wallet orders are paid from your balance, not by receipt' }, 409)
  }

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

  const { data: settings } = await admin
    .from('app_settings').select('payment_ai_enabled, payment_ai_model').eq('id', true).single()
  const aiEnabled = settings?.payment_ai_enabled ?? true
  const model = settings?.payment_ai_model ?? 'claude-opus-4-8'

  if (!aiEnabled) return parkForReview('AI verification is turned off — awaiting admin review.', null)

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

  const isCash = method?.type === 'cash'

  const promptText = isCash
    ? [
        'This is a photo of physical Philippine peso cash (banknotes and/or coins) a customer is paying for an office-pantry purchase.',
        `Amount due: PHP ${order.total}.`,
        'Identify each visible denomination (₱1000/500/200/100/50/20 notes; ₱20/10/5/1 coins) and sum the clearly-visible total.',
        "Set verdict 'pass' ONLY if it is genuinely a photo of real cash AND the clearly-visible total is at least the amount due.",
        "'fail' if the visible cash is clearly less than due or the image is not cash.",
        "'unsure' if blurry, partially hidden, or ambiguous.",
        'Set extracted.amount = the total pesos you counted; set recipient, reference, and timestamp to null.',
      ].join('\n')
    : [
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
      ].join('\n')

  // Ask Claude to read the receipt / cash photo
  let verdict: AiVerdictResult
  let usage: Anthropic.Messages.Usage | undefined
  try {
    const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY')! })
    const response = await anthropic.messages.create({
      model,
      max_tokens: 2048,
      thinking: { type: 'disabled' },
      output_config: { format: { type: 'json_schema', schema: VERDICT_SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
          { type: 'text', text: promptText },
        ],
      }],
    })
    const text = response.content.find((b) => b.type === 'text')
    if (!text || text.type !== 'text') throw new Error('no text block')
    verdict = JSON.parse(text.text) as AiVerdictResult
    usage = response.usage
  } catch (e) {
    return parkForReview(`AI verification unavailable: ${e instanceof Error ? e.message : e}`, null)
  }

  // Log AI usage cost (best-effort; never breaks verification)
  try {
    const cost = computeCost(usage ?? {}, model)
    await admin.from('ai_usage').insert({
      fn: 'verify-payment',
      order_id,
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
      cache_read_tokens: usage?.cache_read_input_tokens ?? 0,
      cache_creation_tokens: usage?.cache_creation_input_tokens ?? 0,
      cost_usd: cost.cost_usd,
      cost_php: cost.cost_php,
    })
  } catch (_) { /* usage logging must never break verification */ }

  // Reference reuse check (blocks screenshot replay) — not applicable to cash
  let refAlreadyUsed = false
  if (!isCash && verdict.extracted.reference) {
    const { count, error: refErr } = await admin
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'paid')
      .neq('id', order_id)
      .eq('ai_verdict->extracted->>reference', verdict.extracted.reference)
    if (refErr) return parkForReview('reference reuse check unavailable: ' + refErr.message, verdict)
    refAlreadyUsed = (count ?? 0) > 0
  }

  const decision = decideOrderStatus(verdict, Number(order.total), refAlreadyUsed, isCash)

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
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}
