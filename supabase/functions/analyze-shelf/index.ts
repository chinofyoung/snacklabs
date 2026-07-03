import { createClient } from 'npm:@supabase/supabase-js@2'
import Anthropic from 'npm:@anthropic-ai/sdk'
import { computeCost } from '../_shared/pricing.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const DETECTIONS_SCHEMA = {
  type: 'object',
  properties: {
    detections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          matched_item_id: { type: ['string', 'null'] },
          name: { type: 'string' },
          qty: { type: 'integer' },
          suggested_price: { type: ['number', 'null'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['matched_item_id', 'name', 'qty', 'suggested_price', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['detections'],
  additionalProperties: false,
} as const

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
  const { photo_path } = await req.json().catch(() => ({}))
  if (!photo_path) return json({ error: 'photo_path required' }, 400)

  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } },
  )
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

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const { data: catalog } = await admin
    .from('items').select('id, name, price').eq('is_active', true)

  const { data: blob, error: dlErr } = await admin.storage.from('restock-photos').download(photo_path)
  if (dlErr || !blob) return json({ error: 'photo could not be read' }, 400)
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let b64 = ''
  const CHUNK = 8192
  for (let i = 0; i < bytes.length; i += CHUNK) {
    b64 += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  b64 = btoa(b64)

  let result: { detections: unknown[] }
  let usage: Anthropic.Messages.Usage | undefined
  try {
    const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY')! })
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      thinking: { type: 'disabled' },
      output_config: { format: { type: 'json_schema', schema: DETECTIONS_SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: blob.type === 'image/png' ? 'image/png' : 'image/jpeg', data: b64 } },
          {
            type: 'text',
            text: [
              'This is a photo of office pantry stock (a shelf or a fresh delivery), taken in the Philippines.',
              'Identify each distinct product and count how many units are visible.',
              '',
              'Current catalog (match against these when the product is the same; use the exact id):',
              JSON.stringify(catalog ?? []),
              '',
              'Rules:',
              '- If a detected product matches a catalog item, set matched_item_id to that id and suggested_price to null.',
              '- If it is not in the catalog, set matched_item_id to null, give a clean product name, and suggest a reasonable PHP retail price.',
              '- qty is your best count of visible units; be conservative.',
              '- confidence reflects how sure you are about the identification AND the count.',
              '- Ignore non-products (shelf fixtures, signage, hands).',
            ].join('\n'),
          },
        ],
      }],
    })
    const text = response.content.find((b) => b.type === 'text')
    if (!text || text.type !== 'text') throw new Error('no text block')
    result = JSON.parse(text.text)
    usage = response.usage
  } catch (e) {
    return json({ error: `AI analysis failed: ${e instanceof Error ? e.message : e}` }, 502)
  }

  const { data: session, error: insErr } = await admin
    .from('restock_sessions')
    .insert({ admin_id: userId, photo_url: photo_path, ai_result: result })
    .select('id')
    .single()
  if (insErr) return json({ error: insErr.message }, 500)

  // Log AI usage cost (best-effort; never breaks the analyze flow)
  try {
    const cost = computeCost(usage ?? {}, 'claude-sonnet-5')
    await admin.from('ai_usage').insert({
      fn: 'analyze-shelf',
      session_id: session.id,
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
      cache_read_tokens: usage?.cache_read_input_tokens ?? 0,
      cache_creation_tokens: usage?.cache_creation_input_tokens ?? 0,
      cost_usd: cost.cost_usd,
      cost_php: cost.cost_php,
    })
  } catch (_) { /* usage logging must never break the analyze flow */ }

  return json({ session_id: session.id, detections: result.detections })
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}
