import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { Ban, ReceiptText } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { formatPeso } from '../lib/money'
import { PERIODS, periodStart, periodLabel, type Period } from '../lib/period'
import type { Order, OrderStatus } from '../types'
import ConfirmDialog from '../components/ConfirmDialog'
import { useAuth } from '../context/AuthContext'

const STATUS_STYLE: Record<OrderStatus, string> = {
  awaiting_payment: 'bg-ink-900/5 text-ink-500',
  verifying: 'bg-blue-50 text-blue-700',
  paid: 'bg-green-50 text-green-700',
  needs_review: 'bg-amber-50 text-amber-700',
  cancelled: 'bg-ink-900/5 text-ink-500 line-through',
}

const PAGE_SIZE = 10

export default function Orders() {
  const { session } = useAuth()
  const userId = session?.user.id ?? null
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [period, setPeriod] = useState<Period>('all')
  // null = the summary read failed (this is only rendered once loading has
  // settled, so it never means "not yet"). Deliberately NOT {count: 0, total: 0}:
  // that would print "No orders" and a ₱0.00 total on a failed read.
  const [summary, setSummary] = useState<{ count: number; total: number } | null>(null)
  // True when the orders read failed. An empty `orders` is only believed as
  // "No orders yet" when this is false.
  const [listFailed, setListFailed] = useState(false)
  const [pendingCancel, setPendingCancel] = useState<Order | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)

  // The "orders read own or admin" policy (supabase/migrations/20260702030220_init.sql)
  // lets an admin's session read every row in the table, so this page must filter to
  // the signed-in user explicitly rather than relying on RLS alone — otherwise an
  // admin viewing "My orders" would see everyone's orders.
  // Resolves true when the page loaded, so "Load more" only advances on success.
  const loadPage = useCallback(async (p: number): Promise<boolean> => {
    if (!userId) return false
    let q = supabase.from('orders').select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE - 1)
    if (period !== 'all') q = q.gte('created_at', periodStart(period)!.toISOString())
    const { data, error } = await q
    // A failed read must not render as "No orders yet". Page 0 clears the list so
    // a stale one never sits under a new period's label; a later page keeps what
    // is already on screen and leaves "Load more" available to retry.
    if (error || !data) {
      if (p === 0) {
        setOrders([])
        setHasMore(false)
      }
      setListFailed(true)
      return false
    }
    setListFailed(false)
    const rows = data as Order[]
    setOrders((prev) => (p === 0 ? rows : [...prev, ...rows]))
    setHasMore(rows.length === PAGE_SIZE)
    return true
  }, [period, userId])

  const loadSummary = useCallback(async () => {
    if (!userId) return
    // PostgREST has no SUM aggregate: the peso total is summed client-side from
    // up to 5000 matching rows. The order count uses Supabase's exact count,
    // which reflects the full filtered match regardless of the range cap.
    let q = supabase.from('orders').select('total', { count: 'exact' }).eq('user_id', userId).range(0, 4999)
    if (period !== 'all') q = q.gte('created_at', periodStart(period)!.toISOString())
    const { data, count, error } = await q
    if (error || !data || count === null) {
      setSummary(null)
      return
    }
    const rows = data as { total: number }[]
    setSummary({ count, total: rows.reduce((sum, r) => sum + Number(r.total), 0) })
  }, [period, userId])

  useEffect(() => {
    // Session hasn't resolved yet — stay in the loading state rather than firing an
    // unscoped (or null-filtered) query, which would risk a flash of "No orders yet".
    if (!userId) return
    setPage(0)
    setLoading(true)
    Promise.all([loadPage(0), loadSummary()]).then(() => setLoading(false))
  }, [loadPage, loadSummary, userId])

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
    <div className="max-w-md mx-auto min-h-dvh px-4 py-4 space-y-4 app-frame pb-28">
      <header>
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
            {summary === null ? (
              <span className="text-red-600" role="alert">Couldn&apos;t load the summary</span>
            ) : summary.count === 0 ? (
              'No orders'
            ) : (
              <>
                {summary.count} order{summary.count === 1 ? '' : 's'} ·{' '}
                <span className="tabular-nums">{formatPeso(summary.total)}</span>
              </>
            )}
          </p>
          {listFailed && (
            <p className="text-sm text-red-600" role="alert">
              Couldn&apos;t load your orders — check your connection and reload.
            </p>
          )}
          {orders.length === 0 ? (
            !listFailed && (
              <div className="text-center py-12 space-y-2">
                <ReceiptText className="size-12 mx-auto text-ink-500" strokeWidth={2.5} aria-hidden="true" />
                <p className="text-ink-700 font-medium">No orders yet</p>
                <p className="text-ink-500 text-sm">Orders you place will show up here.</p>
              </div>
            )
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
          onClick={async () => { const next = page + 1; setLoadingMore(true); if (await loadPage(next)) setPage(next); setLoadingMore(false); }}
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
