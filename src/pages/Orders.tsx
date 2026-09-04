import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { Ban, ReceiptText } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { formatPeso } from '../lib/money'
import { PERIODS, periodStart, periodLabel, type Period } from '../lib/period'
import type { Order, OrderStatus } from '../types'
import ConfirmDialog from '../components/ConfirmDialog'

const STATUS_STYLE: Record<OrderStatus, string> = {
  awaiting_payment: 'bg-ink-900/5 text-ink-500',
  verifying: 'bg-blue-50 text-blue-700',
  paid: 'bg-green-50 text-green-700',
  needs_review: 'bg-amber-50 text-amber-700',
  cancelled: 'bg-ink-900/5 text-ink-500 line-through',
}

const PAGE_SIZE = 10

export default function Orders() {
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [period, setPeriod] = useState<Period>('all')
  const [summaryCount, setSummaryCount] = useState(0)
  const [summaryTotal, setSummaryTotal] = useState(0)
  const [pendingCancel, setPendingCancel] = useState<Order | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)

  // RLS already scopes `orders` reads to the signed-in user (see "orders read own or
  // admin" policy in supabase/migrations/20260702030220_init.sql), so no extra
  // user_id filter is needed here.
  const loadPage = useCallback(async (p: number) => {
    let q = supabase.from('orders').select('*')
      .order('created_at', { ascending: false })
      .range(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE - 1)
    if (period !== 'all') q = q.gte('created_at', periodStart(period)!.toISOString())
    const { data } = await q
    const rows = (data as Order[]) ?? []
    setOrders((prev) => (p === 0 ? rows : [...prev, ...rows]))
    setHasMore(rows.length === PAGE_SIZE)
  }, [period])

  const loadSummary = useCallback(async () => {
    // PostgREST has no SUM aggregate: the peso total is summed client-side from
    // up to 5000 matching rows. The order count uses Supabase's exact count,
    // which reflects the full filtered match regardless of the range cap.
    let q = supabase.from('orders').select('total', { count: 'exact' }).range(0, 4999)
    if (period !== 'all') q = q.gte('created_at', periodStart(period)!.toISOString())
    const { data, count } = await q
    const rows = (data as { total: number }[]) ?? []
    setSummaryCount(count ?? 0)
    setSummaryTotal(rows.reduce((sum, r) => sum + Number(r.total), 0))
  }, [period])

  useEffect(() => {
    setPage(0)
    setLoading(true)
    Promise.all([loadPage(0), loadSummary()]).then(() => setLoading(false))
  }, [loadPage, loadSummary])

  const cancelOrder = async (order: Order) => {
    setCancelling(true)
    setCancelError(null)
    const { error } = await supabase.rpc('cancel_own_order', { p_order_id: order.id })
    setCancelling(false)
    if (error) {
      setCancelError(error.message)
      return
    }
    setPendingCancel(null)
    // The cancelled order affects the period summary too, so reload both
    // from page 0 rather than hand-patching the local `orders` array.
    setPage(0)
    await Promise.all([loadPage(0), loadSummary()])
  }

  return (
    <div className="max-w-md mx-auto min-h-dvh px-4 py-4 space-y-4 app-frame">
      <header className="flex items-center gap-3">
        <Link to="/" className="text-ink-500 text-lg leading-none rounded-md" aria-label="Back to store">←</Link>
        <h1 className="font-display text-xl font-bold">My orders</h1>
      </header>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {PERIODS.map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            aria-pressed={period === p}
            className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium capitalize transition ${
              period === p ? 'bg-ink-900 text-white' : 'bg-surface-raised text-ink-500 shadow-card'
            }`}
          >
            {p}
          </button>
        ))}
      </div>
      {loading ? (
        <p className="text-center text-ink-500 py-8">Loading…</p>
      ) : (
        <>
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
          {orders.length === 0 ? (
            <div className="text-center py-12 space-y-2">
              <ReceiptText className="size-12 mx-auto text-ink-500" strokeWidth={2.5} aria-hidden="true" />
              <p className="text-ink-700 font-medium">No orders yet</p>
              <p className="text-ink-500 text-sm">Orders you place will show up here.</p>
              <Link to="/" className="inline-block text-brand-600 font-semibold mt-2 rounded-md">← Back to store</Link>
            </div>
          ) : (
            orders.map((o) => (
              <div key={o.id} className="rounded-lg bg-surface-raised p-4 shadow-card">
                <Link to={`/pay/${o.id}`} className="block space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-bold tabular-nums">{formatPeso(o.total)}</span>
                    <span className={`text-xs rounded-full px-2.5 py-1 capitalize font-medium ${STATUS_STYLE[o.status]}`}>
                      {o.status.replace('_', ' ')}
                    </span>
                  </div>
                  <p className="text-xs text-ink-500">{new Date(o.created_at).toLocaleString()}</p>
                  {o.status === 'needs_review' && o.ai_verdict?.reason && (
                    <p className="text-xs text-amber-700">{o.ai_verdict.reason}</p>
                  )}
                </Link>
                {o.status === 'awaiting_payment' && (
                  <div className="mt-2 flex justify-end">
                    <button
                      onClick={() => setPendingCancel(o)}
                      aria-label={`Cancel ${formatPeso(o.total)} order from ${new Date(o.created_at).toLocaleString()}`}
                      className="inline-flex items-center gap-1.5 rounded-md bg-ink-900/5 text-ink-700 px-3 py-1.5 text-sm font-medium hover:bg-red-50 hover:text-red-600 active:scale-95 transition"
                    >
                      <Ban className="size-4" strokeWidth={2.5} aria-hidden="true" />
                      Cancel order
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </>
      )}
      {!loading && hasMore && (
        <button
          onClick={async () => { const next = page + 1; setLoadingMore(true); await loadPage(next); setPage(next); setLoadingMore(false); }}
          disabled={loadingMore}
          className="w-full rounded-2xl bg-white shadow-sm py-3.5 font-medium text-ink-900 active:scale-[0.98] transition disabled:opacity-50"
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
      <ConfirmDialog
        open={pendingCancel !== null}
        destructive
        title="Cancel this order?"
        message={pendingCancel && (
          <>
            Cancel your <b>{formatPeso(pendingCancel.total)}</b> order? This cannot be undone.
            {cancelError && (
              <p role="alert" className="text-sm text-red-600 mt-2">{cancelError}</p>
            )}
          </>
        )}
        confirmLabel="Cancel order"
        cancelLabel="Keep order"
        busy={cancelling}
        busyLabel="Cancelling…"
        onConfirm={() => pendingCancel && cancelOrder(pendingCancel)}
        onCancel={() => { setPendingCancel(null); setCancelError(null) }}
      />
    </div>
  )
}
