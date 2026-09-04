import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { ReceiptText } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { formatPeso } from '../../lib/money'
import ConfirmDialog from '../../components/ConfirmDialog'
import { PERIODS, periodStart, periodLabel, type Period } from '../../lib/period'
import type { Order, OrderStatus } from '../../types'

interface OrderRow extends Order {
  profiles: { full_name: string; email: string } | null
}

const FILTERS: (OrderStatus | 'all')[] = ['needs_review', 'all', 'paid', 'verifying', 'awaiting_payment', 'cancelled']
const PAGE_SIZE = 10

export default function AdminOrders() {
  const [params, setParams] = useSearchParams()
  const filter = (params.get('filter') ?? 'needs_review') as OrderStatus | 'all'
  const period = (params.get('period') ?? 'all') as Period
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null)
  const [receiptErr, setReceiptErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [showDeleteAll, setShowDeleteAll] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [pendingReject, setPendingReject] = useState<OrderRow | null>(null)
  const [pendingVoid, setPendingVoid] = useState<OrderRow | null>(null)
  const [voiding, setVoiding] = useState(false)
  const [voidError, setVoidError] = useState<string | null>(null)
  const [summaryCount, setSummaryCount] = useState(0)
  const [summaryTotal, setSummaryTotal] = useState(0)

  const loadPage = useCallback(async (p: number) => {
    let q = supabase.from('orders')
      .select('*, profiles(full_name, email)')
      .order('created_at', { ascending: false })
      .range(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE - 1)
    if (filter !== 'all') q = q.eq('status', filter)
    if (period !== 'all') q = q.gte('created_at', periodStart(period)!.toISOString())
    const { data } = await q
    const rows = (data as OrderRow[]) ?? []
    setOrders((prev) => (p === 0 ? rows : [...prev, ...rows]))
    setHasMore(rows.length === PAGE_SIZE)
  }, [filter, period])

  // PostgREST has no SUM aggregate: the peso total is summed client-side from
  // up to 5000 matching rows. The order count uses Supabase's exact count,
  // which reflects the full filtered match regardless of the range cap.
  const loadSummary = useCallback(async () => {
    let q = supabase.from('orders').select('total', { count: 'exact' }).range(0, 4999)
    if (filter !== 'all') q = q.eq('status', filter)
    if (period !== 'all') q = q.gte('created_at', periodStart(period)!.toISOString())
    const { data, count } = await q
    const rows = (data as { total: number }[]) ?? []
    setSummaryCount(count ?? 0)
    setSummaryTotal(rows.reduce((sum, r) => sum + Number(r.total), 0))
  }, [filter, period])

  useEffect(() => { setPage(0); loadPage(0); loadSummary() }, [loadPage, loadSummary])

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
    await loadSummary()
  }

  const reject = async (o: OrderRow) => {
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
    await loadSummary()
  }

  const voidOrder = async (o: OrderRow) => {
    setVoiding(true)
    setVoidError(null)
    try {
      const { error } = await supabase.rpc('void_order', { p_order_id: o.id })
      if (error) {
        setVoidError(error.message)
        return false
      }
      setOpen(null)
      setPage(0)
      await loadPage(0)
      await loadSummary()
      return true
    } finally {
      setVoiding(false)
    }
  }

  const deleteAll = async () => {
    setDeleting(true)
    try {
      const { error } = await supabase.rpc('delete_all_orders')
      if (error) {
        alert(error.message)
        return false
      }
      setPage(0)
      await loadPage(0)
      await loadSummary()
      return true
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="p-4 md:p-8 space-y-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-2xl font-bold">Orders</h1>
        <button
          onClick={() => setShowDeleteAll(true)}
          className="text-sm text-red-600 font-medium"
        >
          Delete all
        </button>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setParams((prev) => { const next = new URLSearchParams(prev); next.set('filter', f); return next })}
            aria-pressed={filter === f}
            className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium capitalize transition ${
              filter === f ? 'bg-ink-900 text-white' : 'bg-surface-raised text-ink-500 shadow-card'
            }`}
          >
            {f.replace('_', ' ')}
          </button>
        ))}
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {PERIODS.map((p) => (
          <button
            key={p}
            onClick={() => setParams((prev) => { const next = new URLSearchParams(prev); next.set('period', p); return next })}
            aria-pressed={period === p}
            className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium capitalize transition ${
              period === p ? 'bg-ink-900 text-white' : 'bg-surface-raised text-ink-500 shadow-card'
            }`}
          >
            {p}
          </button>
        ))}
      </div>

      <p className="text-sm text-ink-500">
        {periodLabel(period)} ·{' '}
        {summaryCount === 0 ? (
          'No orders'
        ) : (
          <>
            {summaryCount} order{summaryCount === 1 ? '' : 's'} ·{' '}
            <span className="tabular-nums">{formatPeso(summaryTotal)}</span>
          </>
        )}
      </p>

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
                  <div className="flex flex-wrap gap-2">
                    <button onClick={() => setPendingReject(o)} disabled={busy} className="rounded-full bg-red-50 px-4 py-2 text-sm font-medium text-red-600 transition disabled:opacity-50">
                      Reject
                    </button>
                    <button onClick={() => approve(o)} disabled={busy} className="rounded-full bg-green-600 px-4 py-2 text-sm font-medium text-white transition disabled:opacity-50">
                      Approve & mark paid
                    </button>
                  </div>
                )}
                <button
                  onClick={() => setPendingVoid(o)}
                  disabled={busy || voiding}
                  className="rounded-full bg-red-600 px-4 py-2 text-sm font-medium text-white transition disabled:opacity-50"
                >
                  Void & delete
                </button>
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

      <ConfirmDialog
        open={pendingReject !== null}
        destructive
        title="Cancel this order?"
        message={<>Cancel the order from <b>{pendingReject?.profiles?.full_name || pendingReject?.profiles?.email || 'this customer'}</b> ({pendingReject ? formatPeso(pendingReject.total) : ''})?</>}
        confirmLabel="Cancel order"
        cancelLabel="Keep order"
        busy={busy}
        onConfirm={async () => {
          if (pendingReject) await reject(pendingReject)
          setPendingReject(null)
        }}
        onCancel={() => setPendingReject(null)}
      />

      <ConfirmDialog
        open={showDeleteAll}
        destructive
        requireTyped="DELETE"
        title="Delete all transactions?"
        message="This permanently deletes every order and its line items. AI cost history is kept. This cannot be undone."
        confirmLabel="Delete all"
        busy={deleting}
        busyLabel="Deleting…"
        onConfirm={async () => {
          const ok = await deleteAll()
          if (ok) setShowDeleteAll(false)
        }}
        onCancel={() => setShowDeleteAll(false)}
      />

      <ConfirmDialog
        open={pendingVoid !== null}
        destructive
        title="Void this order?"
        message={
          <>
            {voidError && <p className="text-red-600 mb-2" role="alert">{voidError}</p>}
            {pendingVoid?.status === 'paid' ? (
              <>This order is paid. Voiding it will return its line items to stock and remove <b>{pendingVoid ? formatPeso(pendingVoid.total) : ''}</b> from revenue for <b>{pendingVoid?.profiles?.full_name || pendingVoid?.profiles?.email || 'this customer'}</b>. This cannot be undone.</>
            ) : (
              <>This will permanently delete the order from <b>{pendingVoid?.profiles?.full_name || pendingVoid?.profiles?.email || 'this customer'}</b> ({pendingVoid ? formatPeso(pendingVoid.total) : ''}). No stock changes will be made since it was never paid. This cannot be undone.</>
            )}
          </>
        }
        confirmLabel="Void & delete"
        busy={voiding}
        busyLabel="Voiding…"
        onConfirm={async () => {
          if (pendingVoid) {
            const ok = await voidOrder(pendingVoid)
            if (ok) setPendingVoid(null)
          }
        }}
        onCancel={() => { setPendingVoid(null); setVoidError(null) }}
      />
    </div>
  )
}
