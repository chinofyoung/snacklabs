import { Fragment, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { ArrowLeft, Search, Users } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { formatPeso } from '../../lib/money'
import { rankBuyers, type PaidOrderRow } from '../../lib/salesPeople'

interface OrderItemRow {
  order_id: string
  qty: number
  price_at_purchase: number
  items: { name: string } | null
}

const PAGE_SIZE = 10

const dateTimeFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

function formatDateTime(iso: string): string {
  // Intl.DateTimeFormat has no separator option for splitting the date from the
  // time, so swap in the ", " it renders before the time for " · " instead.
  return dateTimeFmt.format(new Date(iso)).replace(/, (\d{1,2}:)/, ' · $1')
}

function rankBadgeClass(rank: number): string {
  if (rank === 1) return 'bg-brand-100 text-brand-700'
  if (rank === 2) return 'bg-brand-50 text-brand-600'
  return 'bg-ink-900/5 text-ink-700'
}

function groupByOrder(items: OrderItemRow[]): Map<string, OrderItemRow[]> {
  const map = new Map<string, OrderItemRow[]>()
  for (const item of items) {
    const existing = map.get(item.order_id)
    if (existing) existing.push(item)
    else map.set(item.order_id, [item])
  }
  return map
}

export default function SalesPeople() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [rows, setRows] = useState<PaidOrderRow[]>([])
  const [truncated, setTruncated] = useState(false)

  const [query, setQuery] = useState('')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

  const [expandedUserIds, setExpandedUserIds] = useState<Set<string>>(new Set())
  const [loadingUserIds, setLoadingUserIds] = useState<Set<string>>(new Set())
  const [itemsByUser, setItemsByUser] = useState<Map<string, OrderItemRow[]>>(new Map())
  const [itemsErrorByUser, setItemsErrorByUser] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    supabase.from('orders')
      .select('id, user_id, total, created_at, profiles(full_name, email)')
      .eq('status', 'paid')
      .order('created_at', { ascending: false })
      .range(0, 4999)
      .then(({ data, error: fetchErr }) => {
        if (cancelled) return
        if (fetchErr) {
          setError(fetchErr.message)
          setLoading(false)
          return
        }
        // orders.user_id -> profiles.id is a many-to-one relation, so this
        // explicit-columns select embeds `profiles` as a single object (or
        // null) at runtime, not an array. postgrest-js's select-string type
        // inference conservatively types every embed as an array without a
        // generated Database schema, which is why a direct `as PaidOrderRow[]`
        // cast is rejected as "insufficiently overlapping" - the same
        // situation as Sales.tsx's order_items -> items embed.
        const orderRows = (data as unknown as PaidOrderRow[]) ?? []
        setRows(orderRows)
        setTruncated(orderRows.length === 5000)
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  const rankedBuyers = useMemo(
    () => rankBuyers(rows).map((buyer, index) => ({ ...buyer, rank: index + 1 })),
    [rows],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rankedBuyers
    return rankedBuyers.filter((b) => b.name.toLowerCase().includes(q) || b.email.toLowerCase().includes(q))
  }, [rankedBuyers, query])

  // A fresh search term can match far fewer rows than were previously
  // revealed - reset back to a single page rather than keep an oddly deep
  // slice sitting on top of a much shorter result set.
  useEffect(() => { setVisibleCount(PAGE_SIZE) }, [query])

  const visibleBuyers = filtered.slice(0, visibleCount)

  const fetchItemsForUser = async (userId: string) => {
    setLoadingUserIds((prev) => new Set(prev).add(userId))
    setItemsErrorByUser((prev) => {
      const next = new Map(prev)
      next.delete(userId)
      return next
    })

    // Filtering via the orders!inner embed avoids an `.in('order_id', orderIds)`
    // fallback, which for a heavy buyer would need every one of their paid
    // order ids serialized as UUIDs into a GET request's query string - the
    // same URL-length risk Sales.tsx avoids for its own order_items query.
    const { data, error: fetchErr } = await supabase.from('order_items')
      .select('order_id, qty, price_at_purchase, items(name), orders!inner(user_id, status)')
      .eq('orders.user_id', userId)
      .eq('orders.status', 'paid')

    setLoadingUserIds((prev) => {
      const next = new Set(prev)
      next.delete(userId)
      return next
    })

    if (fetchErr) {
      setItemsErrorByUser((prev) => new Map(prev).set(userId, fetchErr.message))
      return
    }
    // Same to-one embed situation as the orders query above: order_items ->
    // items is many-to-one, so `items` is a single object at runtime despite
    // the array type postgrest-js infers for this explicit-columns select.
    setItemsByUser((prev) => new Map(prev).set(userId, (data as unknown as OrderItemRow[]) ?? []))
  }

  const toggleExpand = (userId: string) => {
    const wasOpen = expandedUserIds.has(userId)
    setExpandedUserIds((prev) => {
      const next = new Set(prev)
      if (wasOpen) next.delete(userId)
      else next.add(userId)
      return next
    })
    if (!wasOpen && !itemsByUser.has(userId)) {
      void fetchItemsForUser(userId)
    }
  }

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-4xl">
      <div className="space-y-1">
        <Link
          to="/admin/sales"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-500 hover:text-ink-700"
        >
          <ArrowLeft className="size-4" strokeWidth={2.5} aria-hidden="true" />
          Sales
        </Link>
        <h1 className="font-display text-2xl font-bold">Sales per person</h1>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-red-600">{error}</p>
      ) : loading ? (
        <p className="text-sm text-ink-500">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="space-y-2 py-12 text-center">
          <Users className="mx-auto size-12 text-ink-500" strokeWidth={2.5} aria-hidden="true" />
          <p className="font-medium text-ink-700">No sales yet</p>
          <p className="text-sm text-ink-500">No paid orders yet.</p>
        </div>
      ) : (
        <>
          <div className="relative">
            <Search className="size-4 text-ink-500 absolute left-3 top-1/2 -translate-y-1/2" strokeWidth={2.5} aria-hidden="true" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or email"
              className="w-full rounded-md bg-surface-raised border border-line pl-9 pr-3 py-2.5 text-sm outline-none focus-visible:outline-2 focus-visible:outline-brand-700"
            />
          </div>

          {truncated && (
            <p className="text-xs text-ink-500">
              Showing up to 5,000 rows - figures may be truncated if there are more.
            </p>
          )}

          {filtered.length === 0 ? (
            <p className="text-sm text-ink-500">No buyers match your search.</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line">
                      <th scope="col" className="w-10 py-2 text-left font-medium text-ink-500">#</th>
                      <th scope="col" className="py-2 text-left font-medium text-ink-500">Person</th>
                      <th scope="col" className="w-28 py-2 text-right font-medium text-ink-500">Total spent</th>
                      <th scope="col" className="w-16 py-2 text-right font-medium text-ink-500">Orders</th>
                      <th scope="col" className="w-40 py-2 text-right font-medium text-ink-500">Last purchase</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleBuyers.map((buyer) => {
                      const isOpen = expandedUserIds.has(buyer.userId)

                      return (
                        <Fragment key={buyer.userId}>
                          <tr className="border-b border-line">
                            {/* A <button> can't be a direct <tr> child, so the whole row
                                lives in one colSpan cell and lays its columns out with
                                flex internally - keeping the table markup valid while the
                                row stays a single real <button> for click + keyboard + aria-expanded. */}
                            <td colSpan={5} className="p-0">
                              <button
                                type="button"
                                onClick={() => toggleExpand(buyer.userId)}
                                aria-expanded={isOpen}
                                className="flex w-full items-center gap-3 px-0 py-2.5 text-left transition hover:bg-ink-900/5"
                              >
                                <span className="w-10 shrink-0">
                                  {buyer.rank <= 3 ? (
                                    <span className={`inline-flex size-6 items-center justify-center rounded-full text-xs font-bold ${rankBadgeClass(buyer.rank)}`}>
                                      {buyer.rank}
                                    </span>
                                  ) : (
                                    <span className="text-ink-500">{buyer.rank}</span>
                                  )}
                                </span>
                                <span className="min-w-0 grow">
                                  <span className="block truncate font-medium text-ink-900">{buyer.name}</span>
                                  <span className="block truncate text-xs text-ink-500">{buyer.email}</span>
                                </span>
                                <span className="w-28 shrink-0 text-right font-medium tabular-nums text-ink-900">
                                  {formatPeso(buyer.total)}
                                </span>
                                <span className="w-16 shrink-0 text-right tabular-nums text-ink-500">
                                  {buyer.orderCount}
                                </span>
                                <span className="w-40 shrink-0 text-right text-xs text-ink-500">
                                  {formatDateTime(buyer.lastPurchase)}
                                </span>
                              </button>
                            </td>
                          </tr>
                          {isOpen && (() => {
                            // Only scan `rows` and regroup this buyer's items when their
                            // row is actually expanded - `rows` can hold up to 5,000
                            // orders, and most rows on screen stay collapsed.
                            const buyerOrders = rows.filter((r) => r.user_id === buyer.userId)
                            const itemsByOrder = groupByOrder(itemsByUser.get(buyer.userId) ?? [])
                            return (
                              <tr className="border-b border-line bg-surface">
                                <td colSpan={5} className="p-3">
                                  {loadingUserIds.has(buyer.userId) ? (
                                    <p className="text-sm text-ink-500">Loading…</p>
                                  ) : itemsErrorByUser.has(buyer.userId) ? (
                                    <p role="alert" className="text-sm text-red-600">
                                      {itemsErrorByUser.get(buyer.userId)}
                                    </p>
                                  ) : (
                                    <div className="space-y-2">
                                      <p className="text-xs text-ink-500">
                                        {buyer.orderCount} order{buyer.orderCount === 1 ? '' : 's'} · {formatPeso(buyer.total)} total
                                      </p>
                                      {buyerOrders.map((order) => {
                                        const orderItems = itemsByOrder.get(order.id) ?? []
                                        return (
                                          <div key={order.id} className="rounded-md bg-surface-raised p-3 text-sm">
                                            <div className="flex items-baseline justify-between gap-3">
                                              <span className="text-xs text-ink-500">{formatDateTime(order.created_at)}</span>
                                              <span className="shrink-0 font-medium tabular-nums text-ink-900">
                                                {formatPeso(Number(order.total))}
                                              </span>
                                            </div>
                                            <div className="mt-2 space-y-1 border-t border-line pt-2">
                                              {orderItems.length > 0 ? (
                                                orderItems.map((it, i) => (
                                                  <div key={i} className="flex items-baseline justify-between gap-3">
                                                    <span className="flex min-w-0 flex-1 items-baseline gap-1.5 text-ink-900">
                                                      <span className="shrink-0 tabular-nums text-ink-500">{it.qty}×</span>
                                                      <span className="min-w-0 truncate">{it.items?.name ?? 'Unknown item'}</span>
                                                    </span>
                                                    <span className="shrink-0 tabular-nums text-ink-900">
                                                      {formatPeso(it.qty * Number(it.price_at_purchase))}
                                                    </span>
                                                  </div>
                                                ))
                                              ) : (
                                                <p className="text-ink-500">No line items recorded</p>
                                              )}
                                            </div>
                                          </div>
                                        )
                                      })}
                                    </div>
                                  )}
                                </td>
                              </tr>
                            )
                          })()}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <p className="text-xs text-ink-500">
                Showing {visibleBuyers.length} of {filtered.length} buyer{filtered.length === 1 ? '' : 's'}
              </p>
              {filtered.length > visibleCount && (
                <button
                  onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                  className="w-full rounded-2xl bg-white shadow-sm py-3.5 font-medium text-ink-900 active:scale-[0.98] transition"
                >
                  Show more
                </button>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
