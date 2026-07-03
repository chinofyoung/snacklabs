### Task 13: `analyze-shelf` Edge Function + AI Restock page

**Files:**
- Create: `supabase/functions/analyze-shelf/index.ts`, `src/pages/admin/Restock.tsx`
- Modify: `src/App.tsx` (add `<Route path="restock" element={<Restock />} />`)

**Interfaces:**
- Consumes: `restock-photos` bucket, `restock_sessions` table, `apply_restock` RPC, `compressImage`, `RestockDetection`/`RestockSession` types.
- Produces: Edge Function `analyze-shelf`: `POST` body `{ photo_path: string }`, admin JWT required. Responds `{ session_id: string, detections: RestockDetection[] }` or `{ error }`. `/admin/restock` page: take/upload photo → review editable rows → Apply.

- [ ] **Step 1: Edge Function**

`supabase/functions/analyze-shelf/index.ts`:

```ts
import { createClient } from 'npm:@supabase/supabase-js@2'
import Anthropic from 'npm:@anthropic-ai/sdk'

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
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
  const { photo_path } = await req.json().catch(() => ({}))
  if (!photo_path) return json({ error: 'photo_path required' }, 400)

  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } },
  )
  const { data: { user } } = await userClient.auth.getUser()
  if (!user) return json({ error: 'unauthenticated' }, 401)
  const { data: profile } = await userClient
    .from('profiles').select('is_admin').eq('id', user.id).single()
  if (!profile?.is_admin) return json({ error: 'admin only' }, 403)

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
  try {
    const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY')! })
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 4096,
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
  } catch (e) {
    return json({ error: `AI analysis failed: ${e instanceof Error ? e.message : e}` }, 502)
  }

  const { data: session, error: insErr } = await admin
    .from('restock_sessions')
    .insert({ admin_id: user.id, photo_url: photo_path, ai_result: result })
    .select('id')
    .single()
  if (insErr) return json({ error: insErr.message }, 500)

  return json({ session_id: session.id, detections: result.detections })
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
```

- [ ] **Step 2: Deploy**

Run: `supabase functions deploy analyze-shelf` → succeeds.

- [ ] **Step 3: Restock page**

`src/pages/admin/Restock.tsx`:

```tsx
import { useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { compressImage } from '../../lib/image'
import type { RestockDetection } from '../../types'

type Line = RestockDetection & { include: boolean; price: string }
type Phase = 'idle' | 'analyzing' | 'review' | 'applying' | 'done'

export default function Restock() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [preview, setPreview] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const analyze = async (file: File) => {
    setError(null)
    setPhase('analyzing')
    setPreview(URL.createObjectURL(file))
    try {
      const blob = await compressImage(file, 1600, 0.85)
      const path = `${crypto.randomUUID()}.jpg`
      const { error: upErr } = await supabase.storage
        .from('restock-photos').upload(path, blob, { contentType: 'image/jpeg' })
      if (upErr) throw upErr

      const { data, error: fnErr } = await supabase.functions.invoke('analyze-shelf', {
        body: { photo_path: path },
      })
      if (fnErr) throw fnErr
      const detections = (data.detections ?? []) as RestockDetection[]
      setSessionId(data.session_id)
      setLines(detections.map((d) => ({
        ...d,
        include: true,
        price: d.suggested_price != null ? String(d.suggested_price) : '',
      })))
      setPhase('review')
    } catch (e) {
      setPhase('idle')
      setError(e instanceof Error ? e.message : 'Analysis failed — try again.')
    }
  }

  const apply = async () => {
    setPhase('applying')
    setError(null)
    const payload = lines
      .filter((l) => l.include && l.qty > 0)
      .map((l) => ({
        item_id: l.matched_item_id,
        name: l.name,
        price: l.price ? Number(l.price) : 0,
        qty: l.qty,
        category: 'snacks',
      }))
    const { error: rpcErr } = await supabase.rpc('apply_restock', {
      p_session_id: sessionId,
      p_lines: payload,
    })
    if (rpcErr) {
      setPhase('review')
      setError(rpcErr.message)
      return
    }
    setPhase('done')
  }

  const reset = () => {
    setPhase('idle'); setLines([]); setSessionId(null); setPreview(null); setError(null)
  }

  const edit = (i: number, patch: Partial<Line>) =>
    setLines((all) => all.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))

  return (
    <div className="p-4 md:p-8 space-y-4 max-w-3xl">
      <h1 className="text-2xl font-bold">📷 AI Restock</h1>
      <input
        ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden"
        onChange={(e) => e.target.files?.[0] && analyze(e.target.files[0])}
      />

      {phase === 'idle' && (
        <div className="rounded-3xl bg-white p-8 shadow-sm text-center space-y-4">
          <p className="text-5xl">🥡</p>
          <p className="text-ink-500 text-sm">
            Snap a photo of the shelf or a new delivery.<br />
            Claude will count items and match them to your catalog.
          </p>
          <button onClick={() => fileRef.current?.click()} className="rounded-2xl bg-brand-600 text-white px-6 py-3.5 font-bold">
            Take / upload photo
          </button>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      )}

      {phase === 'analyzing' && (
        <div className="rounded-3xl bg-white p-8 shadow-sm text-center space-y-4">
          {preview && <img src={preview} alt="" className="rounded-2xl max-h-64 mx-auto" />}
          <p className="text-ink-500 animate-pulse">Counting snacks with AI…</p>
        </div>
      )}

      {(phase === 'review' || phase === 'applying') && (
        <div className="space-y-3">
          {preview && <img src={preview} alt="" className="rounded-2xl max-h-48 mx-auto" />}
          {lines.length === 0 && <p className="text-center text-ink-500">Nothing detected. Try a clearer photo.</p>}
          {lines.map((l, i) => (
            <div key={i} className={`rounded-2xl bg-white p-3 shadow-sm space-y-2 ${l.include ? '' : 'opacity-40'}`}>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={l.include} onChange={(e) => edit(i, { include: e.target.checked })} className="size-4 accent-brand-600" />
                <input
                  value={l.name}
                  onChange={(e) => edit(i, { name: e.target.value })}
                  className="grow font-medium text-sm bg-transparent outline-none"
                />
                <span className={`text-[10px] rounded-full px-2 py-0.5 ${
                  l.confidence === 'high' ? 'bg-green-50 text-green-700'
                  : l.confidence === 'medium' ? 'bg-amber-50 text-amber-700'
                  : 'bg-red-50 text-red-600'
                }`}>
                  {l.confidence}
                </span>
              </div>
              <div className="flex items-center gap-3 pl-6 text-sm">
                <span className={`rounded-full px-2 py-0.5 text-xs ${l.matched_item_id ? 'bg-blue-50 text-blue-700' : 'bg-purple-50 text-purple-700'}`}>
                  {l.matched_item_id ? 'restock' : 'new item'}
                </span>
                <label className="flex items-center gap-1">
                  qty
                  <input
                    inputMode="numeric" value={l.qty}
                    onChange={(e) => edit(i, { qty: Number(e.target.value) || 0 })}
                    className="w-14 rounded-lg bg-stone-50 border border-stone-200 px-2 py-1 text-center"
                  />
                </label>
                {!l.matched_item_id && (
                  <label className="flex items-center gap-1">
                    ₱
                    <input
                      inputMode="decimal" value={l.price}
                      onChange={(e) => edit(i, { price: e.target.value })}
                      className="w-16 rounded-lg bg-stone-50 border border-stone-200 px-2 py-1 text-center"
                    />
                  </label>
                )}
              </div>
            </div>
          ))}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button onClick={reset} className="grow rounded-2xl bg-stone-100 py-3.5 font-medium">Discard</button>
            <button
              onClick={apply}
              disabled={phase === 'applying' || lines.every((l) => !l.include)}
              className="grow rounded-2xl bg-green-600 text-white py-3.5 font-bold disabled:opacity-50"
            >
              {phase === 'applying' ? 'Applying…' : 'Apply to inventory'}
            </button>
          </div>
        </div>
      )}

      {phase === 'done' && (
        <div className="rounded-3xl bg-green-50 p-8 text-center space-y-3">
          <p className="text-4xl">✅</p>
          <p className="font-bold text-green-800">Inventory updated</p>
          <button onClick={reset} className="text-brand-600 font-medium">Scan another photo</button>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Route + verify**

Add `<Route path="restock" element={<Restock />} />`. Run `npm run build` → succeeds. As admin, upload a photo containing recognizable snacks: detections render as editable rows with matched/new badges; adjust a qty; Apply → matched items' stock increases and new items appear in `/admin/items` and the store (verify: `select name, stock from items order by name;` and `select status from restock_sessions order by created_at desc limit 1;` → `applied`).

---

