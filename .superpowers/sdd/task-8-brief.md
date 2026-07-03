### Task 8: Receipt upload + verification flow + My Orders page

**Files:**
- Create: `src/lib/image.ts`, `src/pages/Orders.tsx`
- Modify: `src/pages/Pay.tsx` (replace the `PaymentStatus` placeholder), `src/App.tsx` (add `/orders`)

**Interfaces:**
- Consumes: `verify-payment` Edge Function (Task 7), `receipts` bucket, `Order`/`AiVerdict` types.
- Produces: `compressImage(file: File, maxDim?: number, quality?: number): Promise<Blob>` in `src/lib/image.ts` (canvas downscale to ≤1600px long edge, JPEG). Used again by Task 13.

- [ ] **Step 1: Image compression util**

`src/lib/image.ts`:

```ts
export async function compressImage(file: File, maxDim = 1600, quality = 0.8): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('compression failed'))),
      'image/jpeg',
      quality,
    ),
  )
}
```

- [ ] **Step 2: Replace `PaymentStatus` in `src/pages/Pay.tsx`**

Replace the placeholder `PaymentStatus` component with:

```tsx
import { useRef, useState } from 'react'
import { compressImage } from '../lib/image'
// (merge these imports with the existing ones at the top of Pay.tsx)

type Phase = 'idle' | 'uploading' | 'verifying' | 'done'

function PaymentStatus({ order, onUpdated }: { order: Order; onUpdated: (o: Order) => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)

  const handleFile = async (file: File) => {
    setError(null)
    setPhase('uploading')
    try {
      const blob = await compressImage(file)
      if (blob.size > 5 * 1024 * 1024) throw new Error('Image too large even after compression')
      const path = `${order.user_id}/${order.id}.jpg`
      const { error: upErr } = await supabase.storage
        .from('receipts')
        .upload(path, blob, { contentType: 'image/jpeg', upsert: true })
      if (upErr) throw upErr

      setPhase('verifying')
      const { data, error: fnErr } = await supabase.functions.invoke('verify-payment', {
        body: { order_id: order.id, receipt_path: path },
      })
      if (fnErr) throw fnErr

      const { data: fresh } = await supabase.from('orders').select('*').eq('id', order.id).single()
      if (fresh) onUpdated(fresh as Order)
      setPhase('done')
      void data
    } catch (e) {
      setPhase('idle')
      setError(e instanceof Error ? e.message : 'Something went wrong — try again.')
    }
  }

  if (order.status === 'paid') {
    return (
      <div className="rounded-2xl bg-green-50 text-green-800 p-5 text-center space-y-1">
        <p className="text-3xl">✅</p>
        <p className="font-bold">Payment verified — enjoy!</p>
      </div>
    )
  }
  if (order.status === 'needs_review') {
    return (
      <div className="rounded-2xl bg-amber-50 text-amber-800 p-5 text-center space-y-1">
        <p className="text-3xl">🕐</p>
        <p className="font-bold">Sent to admin for review</p>
        {order.ai_verdict?.reason && <p className="text-sm">{order.ai_verdict.reason}</p>}
      </div>
    )
  }
  if (order.status === 'cancelled') {
    return <p className="text-center text-ink-500">This order was cancelled.</p>
  }

  return (
    <div className="space-y-2">
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
      />
      <button
        disabled={phase !== 'idle'}
        onClick={() => fileRef.current?.click()}
        className="w-full rounded-2xl bg-brand-600 text-white py-4 font-bold disabled:bg-stone-300 active:scale-[0.98] transition"
      >
        {phase === 'idle' && "I've paid — upload screenshot"}
        {phase === 'uploading' && 'Uploading…'}
        {phase === 'verifying' && 'Verifying with AI…'}
        {phase === 'done' && 'Done'}
      </button>
      {error && <p className="text-sm text-red-600 text-center">{error}</p>}
    </div>
  )
}
```

Wire it in `Pay`: `<PaymentStatus order={order} onUpdated={setOrder} />` (replace the old usage; keep `order.status !== 'awaiting_payment'` handling inside the new component as shown).

- [ ] **Step 3: My Orders page**

`src/pages/Orders.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { supabase } from '../lib/supabase'
import { formatPeso } from '../lib/money'
import type { Order, OrderStatus } from '../types'

const STATUS_STYLE: Record<OrderStatus, string> = {
  awaiting_payment: 'bg-stone-100 text-ink-500',
  verifying: 'bg-blue-50 text-blue-700',
  paid: 'bg-green-50 text-green-700',
  needs_review: 'bg-amber-50 text-amber-700',
  cancelled: 'bg-stone-100 text-ink-500 line-through',
}

export default function Orders() {
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.from('orders').select('*').order('created_at', { ascending: false })
      .then(({ data }) => { setOrders((data as Order[]) ?? []); setLoading(false) })
  }, [])

  return (
    <div className="max-w-md mx-auto min-h-dvh px-4 py-4 space-y-4">
      <header className="flex items-center gap-3">
        <Link to="/" className="text-ink-500">←</Link>
        <h1 className="text-xl font-bold">My orders</h1>
      </header>
      {loading ? (
        <p className="text-center text-ink-500 py-8">Loading…</p>
      ) : orders.length === 0 ? (
        <p className="text-center text-ink-500 py-8">No orders yet.</p>
      ) : (
        orders.map((o) => (
          <Link
            key={o.id}
            to={`/pay/${o.id}`}
            className="block rounded-2xl bg-white p-4 shadow-sm space-y-1"
          >
            <div className="flex items-center justify-between">
              <span className="font-bold">{formatPeso(o.total)}</span>
              <span className={`text-xs rounded-full px-2.5 py-1 capitalize ${STATUS_STYLE[o.status]}`}>
                {o.status.replace('_', ' ')}
              </span>
            </div>
            <p className="text-xs text-ink-500">{new Date(o.created_at).toLocaleString()}</p>
            {o.status === 'needs_review' && o.ai_verdict?.reason && (
              <p className="text-xs text-amber-700">{o.ai_verdict.reason}</p>
            )}
          </Link>
        ))
      )}
    </div>
  )
}
```

Add route: `<Route path="/orders" element={<RequireAuth><Orders /></RequireAuth>} />`.

- [ ] **Step 4: End-to-end verification**

Run: `npm run test` and `npm run build` → both pass. Then in the dev app: place an order, upload a real GCash/bank screenshot (or any image — expect `needs_review` for a random image). Verify:
- Random image → status becomes `needs_review`, reason shown.
- SQL check: `select status, ai_verdict->>'reason' from orders order by created_at desc limit 1;`
- If a genuine matching screenshot is available, it should go `paid` and item stock should decrement (`select name, stock from items;`).

---

