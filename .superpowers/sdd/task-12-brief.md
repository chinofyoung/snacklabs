### Task 12: Admin — Orders list + review queue

**Files:**
- Create: `src/pages/admin/AdminOrders.tsx`
- Modify: `src/App.tsx` (add `<Route path="orders" element={<AdminOrders />} />`)

**Interfaces:**
- Consumes: `Order`, `confirm_order` RPC (admins pass the `is_admin()` check inside it), `receipts` bucket (signed URLs), `profiles`.
- Produces: `/admin/orders?filter=<status>` — filterable list; `needs_review` orders expand to show the receipt image beside the AI verdict, with Approve (→ `confirm_order`) and Reject (→ status `cancelled`) buttons.

- [ ] **Step 1: Implement `src/pages/admin/AdminOrders.tsx`**

```tsx
import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { supabase } from '../../lib/supabase'
import { formatPeso } from '../../lib/money'
import type { Order, OrderStatus } from '../../types'

interface OrderRow extends Order {
  profiles: { full_name: string; email: string } | null
}

const FILTERS: (OrderStatus | 'all')[] = ['needs_review', 'all', 'paid', 'verifying', 'awaiting_payment', 'cancelled']

export default function AdminOrders() {
  const [params, setParams] = useSearchParams()
  const filter = (params.get('filter') ?? 'needs_review') as OrderStatus | 'all'
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    let q = supabase.from('orders')
      .select('*, profiles(full_name, email)')
      .order('created_at', { ascending: false })
      .limit(100)
    if (filter !== 'all') q = q.eq('status', filter)
    const { data } = await q
    setOrders((data as OrderRow[]) ?? [])
  }, [filter])

  useEffect(() => { load() }, [load])

  const openOrder = async (o: OrderRow) => {
    setOpen(open === o.id ? null : o.id)
    setReceiptUrl(null)
    if (o.receipt_image_url) {
      const { data } = await supabase.storage
        .from('receipts').createSignedUrl(o.receipt_image_url, 300)
      setReceiptUrl(data?.signedUrl ?? null)
    }
  }

  const approve = async (o: OrderRow) => {
    setBusy(true)
    const { error } = await supabase.rpc('confirm_order', { p_order_id: o.id, p_verdict: null })
    setBusy(false)
    if (error) { alert(error.message); return }
    setOpen(null)
    await load()
  }

  const reject = async (o: OrderRow) => {
    if (!confirm('Cancel this order?')) return
    setBusy(true)
    await supabase.from('orders').update({ status: 'cancelled' }).eq('id', o.id)
    setBusy(false)
    setOpen(null)
    await load()
  }

  return (
    <div className="p-4 md:p-8 space-y-4 max-w-3xl">
      <h1 className="text-2xl font-bold">Orders</h1>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setParams({ filter: f })}
            className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm capitalize ${
              filter === f ? 'bg-ink-900 text-white' : 'bg-white text-ink-500 shadow-sm'
            }`}
          >
            {f.replace('_', ' ')}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {orders.length === 0 && <p className="text-sm text-ink-500 py-6 text-center">Nothing here.</p>}
        {orders.map((o) => (
          <div key={o.id} className="rounded-2xl bg-white shadow-sm overflow-hidden">
            <button onClick={() => openOrder(o)} className="w-full p-3 flex items-center justify-between text-left">
              <div>
                <p className="font-medium text-sm">{o.profiles?.full_name || o.profiles?.email || 'Unknown'}</p>
                <p className="text-xs text-ink-500">{new Date(o.created_at).toLocaleString()}</p>
              </div>
              <div className="text-right">
                <p className="font-bold">{formatPeso(o.total)}</p>
                <p className="text-xs capitalize text-ink-500">{o.status.replace('_', ' ')}</p>
              </div>
            </button>

            {open === o.id && (
              <div className="border-t border-stone-100 p-3 space-y-3">
                {o.ai_verdict && (
                  <div className="rounded-xl bg-stone-50 p-3 text-sm space-y-1">
                    <p><b>AI verdict:</b> {o.ai_verdict.verdict}</p>
                    <p><b>Read amount:</b> {o.ai_verdict.extracted.amount != null ? formatPeso(o.ai_verdict.extracted.amount) : '—'}</p>
                    <p><b>Reference:</b> {o.ai_verdict.extracted.reference ?? '—'}</p>
                    <p className="text-ink-500">{o.ai_verdict.reason}</p>
                  </div>
                )}
                {receiptUrl
                  ? <img src={receiptUrl} alt="Receipt" className="rounded-xl max-h-96 mx-auto" />
                  : o.receipt_image_url && <p className="text-xs text-ink-500">Loading receipt…</p>}
                {['needs_review', 'verifying', 'awaiting_payment'].includes(o.status) && (
                  <div className="flex gap-2">
                    <button onClick={() => reject(o)} disabled={busy} className="grow rounded-xl bg-red-50 text-red-600 py-3 font-medium disabled:opacity-50">
                      Reject
                    </button>
                    <button onClick={() => approve(o)} disabled={busy} className="grow rounded-xl bg-green-600 text-white py-3 font-medium disabled:opacity-50">
                      Approve & mark paid
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Route + verify**

Add `<Route path="orders" element={<AdminOrders />} />`. Run `npm run build` → succeeds. As admin: the `needs_review` order from Task 8 shows AI verdict + receipt image (signed URL loads). Approve it → status `paid`, stock decrements (verify in SQL). Reject flow sets `cancelled`. Dashboard review count drops to 0.

---

