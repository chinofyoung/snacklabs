import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { ChevronRight, PartyPopper, Sparkles, TrendingUp } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { formatPeso } from '../../lib/money'
import { projectedSales, remainingUnits } from '../../lib/inventory'
import type { Item, Order } from '../../types'

const PAGE_SIZE = 5

// The inline failure note every tile uses, so a failed read says so instead of
// rendering as a confident zero (or, for low stock, as "All stocked up").
function LoadFailed({ what }: { what: string }) {
  return <p className="text-xs text-red-600 mt-1" role="alert">Couldn&apos;t load {what}</p>
}

export default function Dashboard() {
  // null = not loaded yet, or the read failed. Deliberately NOT 0: this is a money
  // figure, and an admin reads ₱0.00 as "nobody bought anything today".
  const [todaySales, setTodaySales] = useState<number | null>(null)
  const [salesFailed, setSalesFailed] = useState(false)
  // null = not loaded yet, or the read failed. Deliberately NOT 0: a failed query
  // must not read as "no orders need review" while paid receipts sit unconfirmed.
  const [reviewCount, setReviewCount] = useState<number | null>(null)
  const [reviewFailed, setReviewFailed] = useState(false)
  // null = not loaded yet, or the read failed. Deliberately NOT 0: an unreachable
  // topup_requests table must not read as "nothing to approve" and hide real work.
  const [topupCount, setTopupCount] = useState<number | null>(null)
  const [topupFailed, setTopupFailed] = useState(false)
  // null = not loaded yet, or the read failed. Deliberately NOT []: a failed read
  // must not read as "Projected sales ₱0.00 if all 0 units sell", and above all not
  // as "All stocked up", a false success.
  const [items, setItems] = useState<Item[] | null>(null)
  const [itemsFailed, setItemsFailed] = useState(false)
  // items is fetched once on mount (see effect below), and lowStock below is
  // derived from items on every render, so PAGE_SIZE as the initial value is
  // always the right starting point — no reset effect needed.
  const [lowStockVisible, setLowStockVisible] = useState(PAGE_SIZE)
  // null = not loaded yet, or the read failed. Deliberately NOT zeros: ₱0.00 AI
  // cost and "0 calls" would read as the feature costing nothing.
  const [ai, setAi] = useState<{ todayPhp: number; totalPhp: number; count: number } | null>(null)
  const [aiFailed, setAiFailed] = useState(false)

  useEffect(() => {
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)

    supabase.from('orders').select('total')
      .eq('status', 'paid').gte('created_at', startOfDay.toISOString())
      .then(({ data, error }) => {
        const failed = error !== null || data === null
        setSalesFailed(failed)
        setTodaySales(failed ? null : (data as Pick<Order, 'total'>[]).reduce((s, o) => s + Number(o.total), 0))
      })

    supabase.from('orders').select('id', { count: 'exact', head: true })
      .eq('status', 'needs_review')
      .then(({ count, error }) => {
        const failed = error !== null || count === null
        setReviewFailed(failed)
        setReviewCount(failed ? null : count)
      })

    supabase.from('topup_requests').select('id', { count: 'exact', head: true })
      .eq('status', 'pending')
      .then(({ count, error }) => {
        const failed = error !== null || count === null
        setTopupFailed(failed)
        setTopupCount(failed ? null : count)
      })

    supabase.from('items').select('*').eq('is_active', true)
      .then(({ data, error }) => {
        const failed = error !== null || data === null
        setItemsFailed(failed)
        setItems(failed ? null : (data as Item[]))
      })

    supabase.from('ai_usage').select('cost_php, created_at')
      .then(({ data, error }) => {
        const failed = error !== null || data === null
        setAiFailed(failed)
        if (failed) {
          setAi(null)
          return
        }
        const rows = data as { cost_php: number; created_at: string }[]
        setAi({
          totalPhp: rows.reduce((s, r) => s + Number(r.cost_php), 0),
          todayPhp: rows.filter(r => r.created_at >= startOfDay.toISOString()).reduce((s, r) => s + Number(r.cost_php), 0),
          count: rows.length,
        })
      })
  }, [])

  // Only meaningful once `items` has loaded; every use below is behind a null check.
  const lowStock = (items ?? []).filter((i) => i.stock <= i.low_stock_threshold)
  const projectedSalesTotal = projectedSales(items ?? [])
  const remainingStock = remainingUnits(items ?? [])

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-3xl">
      <h1 className="font-display text-2xl font-bold">Dashboard</h1>
      <div className="grid grid-cols-2 gap-3">
        <Link to="/admin/sales" className="rounded-lg bg-surface-raised p-5 shadow-card transition hover:shadow-none">
          <p className="text-sm text-ink-500 flex items-center justify-between">
            Sales today
            <ChevronRight className="size-4 text-ink-500" strokeWidth={2.5} aria-hidden="true" />
          </p>
          <p className="text-2xl font-black text-brand-700 tabular-nums">
            {todaySales === null ? '—' : formatPeso(todaySales)}
          </p>
          {salesFailed && <LoadFailed what="sales" />}
        </Link>
        <Link to="/admin/orders?filter=needs_review" className="rounded-lg bg-surface-raised p-5 shadow-card transition hover:shadow-none">
          <p className="text-sm text-ink-500 flex items-center justify-between">
            Needs review
            <ChevronRight className="size-4 text-ink-500" strokeWidth={2.5} aria-hidden="true" />
          </p>
          <p className={`text-2xl font-black tabular-nums ${reviewCount !== null && reviewCount > 0 ? 'text-amber-600' : 'text-ink-900'}`}>
            {reviewCount ?? '—'}
          </p>
          {reviewFailed && <LoadFailed what="the count" />}
        </Link>
        <Link to="/admin/topups" className="rounded-lg bg-surface-raised p-5 shadow-card col-span-2 transition hover:shadow-none">
          <p className="text-sm text-ink-500 flex items-center justify-between">
            Top-ups to approve
            <ChevronRight className="size-4 text-ink-500" strokeWidth={2.5} aria-hidden="true" />
          </p>
          <p className={`text-2xl font-black tabular-nums ${topupCount !== null && topupCount > 0 ? 'text-amber-600' : 'text-ink-900'}`}>
            {topupCount ?? '—'}
          </p>
          {topupFailed && <LoadFailed what="the count" />}
        </Link>
        <Link to="/admin/items" className="rounded-lg bg-surface-raised p-5 shadow-card col-span-2 transition hover:shadow-none">
          <p className="text-sm text-ink-500 flex items-center justify-between">
            <span className="flex items-center gap-1">
              <TrendingUp className="size-3.5" strokeWidth={2.5} aria-hidden="true" /> Projected sales
            </span>
            <ChevronRight className="size-4 text-ink-500" strokeWidth={2.5} aria-hidden="true" />
          </p>
          <p className="text-2xl font-black text-brand-700 tabular-nums">
            {items === null ? '—' : formatPeso(projectedSalesTotal)}
          </p>
          {items !== null && (
            <p className="text-xs text-ink-500 mt-1">
              if all {remainingStock.toLocaleString()} unit{remainingStock === 1 ? '' : 's'} of remaining stock sell
            </p>
          )}
          {itemsFailed && <LoadFailed what="stock" />}
        </Link>
        <div className="rounded-lg bg-surface-raised p-5 shadow-card col-span-2">
          <p className="text-sm text-ink-500 flex items-center gap-1">
            <Sparkles className="size-3.5" strokeWidth={2.5} aria-hidden="true" /> AI cost today
          </p>
          <p className="text-2xl font-black text-brand-700 tabular-nums">
            {ai === null ? '—' : formatPeso(ai.todayPhp)}
          </p>
          {ai !== null && (
            <p className="text-xs text-ink-500 mt-1">
              all-time {formatPeso(ai.totalPhp)} · {ai.count} calls · at ₱58.50 / $1
            </p>
          )}
          {aiFailed && <LoadFailed what="AI usage" />}
        </div>
      </div>
      <section className="space-y-2">
        <h2 className="font-semibold text-sm text-ink-700">Low stock</h2>
        {items === null ? (
          // Never "All stocked up" while the answer is unknown: that is a false
          // success, worse than a false zero. (The projected-sales tile above
          // already raises the alert for a failed read, so this is plain text.)
          itemsFailed
            ? <p className="text-sm text-red-600">Couldn&apos;t load stock</p>
            : <p className="text-sm text-ink-500">Loading…</p>
        ) : lowStock.length === 0 ? (
          <p className="text-sm text-ink-500 flex items-center gap-1">
            All stocked up <PartyPopper className="size-4" strokeWidth={2.5} aria-hidden="true" />
          </p>
        ) : (
          <>
            {lowStock.slice(0, lowStockVisible).map((i) => (
              <div key={i.id} className="rounded-md bg-surface-raised p-3 shadow-card flex justify-between text-sm">
                <span>{i.name}</span>
                <span className="font-bold text-amber-600 tabular-nums">{i.stock} left</span>
              </div>
            ))}
            {lowStock.length > lowStockVisible && (
              <button
                onClick={() => setLowStockVisible((c) => c + PAGE_SIZE)}
                className="w-full rounded-2xl bg-white shadow-sm py-3.5 font-medium text-ink-900 active:scale-[0.98] transition"
              >
                Show {Math.min(PAGE_SIZE, lowStock.length - lowStockVisible)} more
              </button>
            )}
          </>
        )}
      </section>
    </div>
  )
}
