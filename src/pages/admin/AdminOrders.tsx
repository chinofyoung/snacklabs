import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { ReceiptText } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { formatPeso } from '../../lib/money'
import type { Order, OrderStatus } from '../../types'

interface OrderRow extends Order {
  profiles: { full_name: string; email: string } | null
}

const FILTERS: (OrderStatus | 'all')[] = ['needs_review', 'all', 'paid', 'verifying', 'awaiting_payment', 'cancelled']
const PAGE_SIZE = 10

export default function AdminOrders() {
  const [params, setParams] = useSearchParams()
  const filter = (params.get('filter') ?? 'needs_review') as OrderStatus | 'all'
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null)
  const [receiptErr, setReceiptErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  const loadPage = useCallback(async (p: number) => {
    let q = supabase.from('orders')
      .select('*, profiles(full_name, email)')
      .order('created_at', { ascending: false })
      .range(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE - 1)
    if (filter !== 'all') q = q.eq('status', filter)
    const { data } = await q
    const rows = (data as OrderRow[]) ?? []
    setOrders((prev) => (p === 0 ? rows : [...prev, ...rows]))
    setHasMore(rows.length === PAGE_SIZE)
  }, [filter])

  useEffect(() => { setPage(0); loadPage(0) }, [loadPage])

  const openOrder = async (o: OrderRow) => {
    setOpen(open === o.id ? null : o.id)
    setReceiptUrl(null)
    setReceiptErr(null)
    if (o.receipt_image_url) {
      const { data, error: urlErr } = await supabase.storage
        .from('receipts').createSignedUrl(o.receipt_image_url, 300)
      if (urlErr) {
        setReceiptErr('Receipt could not be loaded: ' + urlErr.message)
      } else {
        setReceiptUrl(data?.signedUrl ?? null)
      }
    }
  }

  const approve = async (o: OrderRow) => {
    setBusy(true)
    const { error } = await supabase.rpc('confirm_order', { p_order_id: o.id, p_verdict: null })
    setBusy(false)
    if (error) { alert(error.message); return }
    setOpen(null)
    setPage(0)
    await loadPage(0)
  }

  const reject = async (o: OrderRow) => {
    if (!confirm('Cancel this order?')) return
    setBusy(true)
    const { error: rejErr } = await supabase.from('orders').update({ status: 'cancelled' }).eq('id', o.id)
    if (rejErr) {
      alert(rejErr.message)
      setBusy(false)
      return
    }
    setBusy(false)
    setOpen(null)
    setPage(0)
    await loadPage(0)
  }

  return (
    <div className="p-4 md:p-8 space-y-4 max-w-3xl">
      <h1 className="font-display text-2xl font-bold">Orders</h1>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setParams({ filter: f })}
            className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium capitalize transition ${
              filter === f ? 'bg-ink-900 text-white' : 'bg-surface-raised text-ink-500 shadow-card'
            }`}
          >
            {f.replace('_', ' ')}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {orders.length === 0 && (
          <div className="text-center py-12 space-y-2">
            <ReceiptText className="size-12 mx-auto text-ink-500" strokeWidth={2.5} aria-hidden="true" />
            <p className="text-ink-700 font-medium">Nothing here</p>
            <p className="text-ink-500 text-sm">No orders match this filter.</p>
          </div>
        )}
        {orders.map((o) => (
          <div key={o.id} className="rounded-lg bg-surface-raised shadow-card overflow-hidden">
            <button onClick={() => openOrder(o)} className="w-full p-3 flex items-center justify-between text-left">
              <div>
                <p className="font-medium text-sm">{o.profiles?.full_name || o.profiles?.email || 'Unknown'}</p>
                <p className="text-xs text-ink-500">{new Date(o.created_at).toLocaleString()}</p>
              </div>
              <div className="text-right">
                <p className="font-bold tabular-nums">{formatPeso(o.total)}</p>
                <p className="text-xs capitalize text-ink-500">{o.status.replace('_', ' ')}</p>
              </div>
            </button>

            {open === o.id && (
              <div className="border-t border-line p-3 space-y-3">
                {o.ai_verdict && (
                  <div className="rounded-md bg-surface p-3 text-sm space-y-1">
                    <p><b>AI verdict:</b> {o.ai_verdict.verdict}</p>
                    <p><b>Read amount:</b> {o.ai_verdict.extracted.amount != null ? formatPeso(o.ai_verdict.extracted.amount) : '—'}</p>
                    <p><b>Reference:</b> {o.ai_verdict.extracted.reference ?? '—'}</p>
                    <p className="text-ink-500">{o.ai_verdict.reason}</p>
                  </div>
                )}
                {receiptErr
                  ? <p className="text-xs text-red-600" role="alert">{receiptErr}</p>
                  : receiptUrl
                  ? <img src={receiptUrl} alt="Receipt" className="rounded-md max-h-96 mx-auto" />
                  : o.receipt_image_url && <p className="text-xs text-ink-500">Loading receipt…</p>}
                {['needs_review', 'verifying', 'awaiting_payment'].includes(o.status) && (
                  <div className="flex gap-2">
                    <button onClick={() => reject(o)} disabled={busy} className="grow rounded-md bg-red-50 text-red-600 py-3 font-medium disabled:opacity-50">
                      Reject
                    </button>
                    <button onClick={() => approve(o)} disabled={busy} className="grow rounded-md bg-green-600 text-white py-3 font-medium disabled:opacity-50">
                      Approve & mark paid
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {hasMore && (
        <button
          onClick={async () => { const next = page + 1; setLoadingMore(true); await loadPage(next); setPage(next); setLoadingMore(false); }}
          disabled={loadingMore}
          className="w-full rounded-2xl bg-white shadow-sm py-3.5 font-medium text-ink-900 active:scale-[0.98] transition disabled:opacity-50"
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  )
}
