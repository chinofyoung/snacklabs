import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ReceiptText } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { formatPeso } from '../../lib/money'
import { bucketIndexFor, bucketsFor, rangeFor, type RangePreset } from '../../lib/salesRange'

const PRESETS: RangePreset[] = ['day', 'week', 'month', 'year', 'custom']

const PRESET_LABELS: Record<RangePreset, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
  year: 'Year',
  custom: 'Custom',
}

interface PaidOrderRow {
  total: number
  created_at: string
}

interface LineItemRow {
  qty: number
  price_at_purchase: number
  items: { name: string } | null
}

interface TopItem {
  name: string
  amount: number
}

type RangeResult =
  | { status: 'ready'; start: Date; end: Date }
  | { status: 'incomplete' }
  | { status: 'invalid' }

// <input type="date"> values are YYYY-MM-DD local calendar dates with no time
// component. Build the Date from the numeric parts directly instead of
// `new Date(value)`, which parses as UTC midnight and can shift the calendar
// day by one in a non-UTC timezone.
function parseDateInput(value: string): Date {
  const [y, m, d] = value.split('-').map(Number)
  return new Date(y, m - 1, d, 0, 0, 0, 0)
}

function truncateLabel(name: string, max: number): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name
}

export default function Sales() {
  const [preset, setPreset] = useState<RangePreset>('month')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')

  // True initially so the empty state doesn't flash before the first fetch
  // resolves on mount - the default preset ('month') is immediately "ready".
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [orders, setOrders] = useState<PaidOrderRow[]>([])
  const [lineItems, setLineItems] = useState<LineItemRow[]>([])
  const [truncatedOrders, setTruncatedOrders] = useState(false)
  const [truncatedItems, setTruncatedItems] = useState(false)

  const requestIdRef = useRef(0)

  const range = useMemo<RangeResult>(() => {
    if (preset !== 'custom') return { status: 'ready', ...rangeFor(preset) }
    if (customStart === '' || customEnd === '') return { status: 'incomplete' }

    const start = parseDateInput(customStart)
    const endOfDay = parseDateInput(customEnd)
    if (endOfDay.getTime() < start.getTime()) return { status: 'invalid' }

    // The date input's end value means "through the end of that day"
    // (inclusive), but rangeFor/bucketsFor/bucketIndexFor all work with an
    // EXCLUSIVE end. Convert by stepping the parsed end-of-day forward one
    // calendar day - via setDate, never by adding a fixed 86400000ms, so
    // this stays correct across a DST transition the same way
    // salesRange.ts's own bucket stepping does. Don't "fix" this into
    // `endOfDay` itself; that would make the inverted-range guard above
    // reject a legitimate single-day range.
    const end = new Date(endOfDay.getTime())
    end.setDate(end.getDate() + 1)

    return { status: 'ready', start, end }
  }, [preset, customStart, customEnd])

  const load = useCallback(async (start: Date, end: Date) => {
    const requestId = ++requestIdRef.current
    setLoading(true)
    setError(null)

    const [ordersRes, itemsRes] = await Promise.all([
      supabase.from('orders')
        .select('total, created_at')
        .eq('status', 'paid')
        .gte('created_at', start.toISOString())
        .lt('created_at', end.toISOString())
        .range(0, 4999),
      // Filtering an embedded resource requires the `!inner` join qualifier
      // for the filter to act as a WHERE clause rather than a post-hoc
      // filter applied after the join - a standard, long-documented
      // supabase-js/PostgREST resource-embedding pattern (not empirically
      // verified against a live project in this environment). It's used
      // deliberately in place of an `.in('order_id', ids)` fallback: that
      // alternative needs the full list of paid-order ids from the orders
      // query above to pass into `.in()`, and at the 5000-row cap that's up
      // to 5000 UUIDs (~180KB) serialized into a GET request's query
      // string - a failure mode that risks exceeding practical URL-length
      // limits, landing exactly on the large-range scenario this page has
      // to handle gracefully. The embedded filter never needs that
      // client-side id list at all.
      supabase.from('order_items')
        .select('qty, price_at_purchase, items(name), orders!inner(created_at, status)')
        .eq('orders.status', 'paid')
        .gte('orders.created_at', start.toISOString())
        .lt('orders.created_at', end.toISOString())
        .range(0, 4999),
    ])

    // A newer range change already started its own load - let that one own
    // the state update instead of clobbering it with this stale response.
    if (requestId !== requestIdRef.current) return

    if (ordersRes.error || itemsRes.error) {
      setError(ordersRes.error?.message ?? itemsRes.error?.message ?? 'Failed to load sales data.')
      setLoading(false)
      return
    }

    const orderRows = (ordersRes.data as PaidOrderRow[]) ?? []
    // order_items -> items and order_items -> orders are both many-to-one
    // relations (order_items.item_id / order_items.order_id are the FKs), so at
    // runtime this embed is a single object (or null), not an array. Without a
    // generated Database schema, postgrest-js's select-string type inference
    // can't know the relationship cardinality and conservatively types every
    // embed as an array, which is why a direct `as LineItemRow[]` cast is
    // rejected as "insufficiently overlapping" - going through `unknown` opts
    // out of that check because we know the real runtime shape.
    const itemRows = (itemsRes.data as unknown as LineItemRow[]) ?? []

    setOrders(orderRows)
    setLineItems(itemRows)
    setTruncatedOrders(orderRows.length === 5000)
    setTruncatedItems(itemRows.length === 5000)
    setLoading(false)
  }, [])

  useEffect(() => {
    if (range.status !== 'ready') {
      setError(null)
      setLoading(false)
      return
    }
    load(range.start, range.end)
  }, [range, load])

  const revenue = useMemo(() => orders.reduce((sum, o) => sum + Number(o.total), 0), [orders])
  const itemsSold = useMemo(() => lineItems.reduce((sum, li) => sum + li.qty, 0), [lineItems])

  const { buckets, bucketValues } = useMemo(() => {
    if (range.status !== 'ready') return { buckets: [] as { start: Date; label: string }[], bucketValues: [] as number[] }
    const { buckets: rangeBuckets } = bucketsFor(range.start, range.end)
    const values = new Array(rangeBuckets.length).fill(0) as number[]
    for (const o of orders) {
      const idx = bucketIndexFor(new Date(o.created_at), rangeBuckets, range.end)
      if (idx === -1) continue
      values[idx] += Number(o.total)
    }
    return { buckets: rangeBuckets, bucketValues: values }
  }, [range, orders])

  const topItems = useMemo(() => {
    const totals = new Map<string, number>()
    for (const li of lineItems) {
      const name = li.items?.name ?? 'Unknown item'
      totals.set(name, (totals.get(name) ?? 0) + li.qty * li.price_at_purchase)
    }
    return Array.from(totals.entries())
      .map(([name, amount]): TopItem => ({ name, amount }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5)
  }, [lineItems])

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-4xl">
      <h1 className="font-display text-2xl font-bold">Sales</h1>

      <div className="flex gap-2 overflow-x-auto pb-1">
        {PRESETS.map((p) => (
          <button
            key={p}
            onClick={() => setPreset(p)}
            aria-pressed={preset === p}
            className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium transition ${
              preset === p ? 'bg-ink-900 text-white' : 'bg-surface-raised text-ink-500 shadow-card'
            }`}
          >
            {PRESET_LABELS[p]}
          </button>
        ))}
      </div>

      {preset === 'custom' && (
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-sm text-ink-700">
            Start
            <input
              type="date"
              value={customStart}
              onChange={(e) => setCustomStart(e.target.value)}
              className="rounded-md border border-line bg-surface-raised px-3 py-1.5 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-ink-700">
            End
            <input
              type="date"
              value={customEnd}
              onChange={(e) => setCustomEnd(e.target.value)}
              className="rounded-md border border-line bg-surface-raised px-3 py-1.5 text-sm"
            />
          </label>
        </div>
      )}

      {preset === 'custom' && range.status === 'incomplete' && (
        <p className="text-sm text-ink-500">Pick a start and end date to see this range.</p>
      )}
      {preset === 'custom' && range.status === 'invalid' && (
        <p className="text-sm text-red-600">End date must be on or after the start date.</p>
      )}

      {error ? (
        <p role="alert" className="text-sm text-red-600">{error}</p>
      ) : range.status !== 'ready' ? null : loading ? (
        <p className="text-sm text-ink-500">Loading…</p>
      ) : orders.length === 0 ? (
        <div className="space-y-2 py-12 text-center">
          <ReceiptText className="mx-auto size-12 text-ink-500" strokeWidth={2.5} aria-hidden="true" />
          <p className="font-medium text-ink-700">No sales yet</p>
          <p className="text-sm text-ink-500">No paid orders in this range.</p>
        </div>
      ) : (
        <>
          {(truncatedOrders || truncatedItems) && (
            <p className="text-xs text-ink-500">
              Showing up to 5,000 rows for this range - figures may be truncated if there are more.
            </p>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg bg-surface-raised p-5 shadow-card">
              <p className="text-sm text-ink-500">Revenue</p>
              <p className="text-2xl font-black text-ink-900 tabular-nums">{formatPeso(revenue)}</p>
            </div>
            <div className="rounded-lg bg-surface-raised p-5 shadow-card">
              <p className="text-sm text-ink-500">Orders</p>
              <p className="text-2xl font-black text-ink-900 tabular-nums">{orders.length}</p>
            </div>
            <div className="rounded-lg bg-surface-raised p-5 shadow-card">
              <p className="text-sm text-ink-500">Average order value</p>
              <p className="text-2xl font-black text-ink-900 tabular-nums">
                {orders.length === 0 ? formatPeso(0) : formatPeso(revenue / orders.length)}
              </p>
            </div>
            <div className="rounded-lg bg-surface-raised p-5 shadow-card">
              <p className="text-sm text-ink-500">Items sold</p>
              <p className="text-2xl font-black text-ink-900 tabular-nums">{itemsSold}</p>
            </div>
          </div>

          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-ink-700">Revenue over time</h2>
            <RevenueChart buckets={buckets} values={bucketValues} />
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-ink-700">Top items</h2>
            <TopItemsChart items={topItems} />
          </section>
        </>
      )}
    </div>
  )
}

interface RevenueChartProps {
  buckets: { start: Date; label: string }[]
  values: number[]
}

function RevenueChart({ buckets, values }: RevenueChartProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

  const viewWidth = 640
  const viewHeight = 220
  const marginLeft = 48
  const marginRight = 8
  const marginTop = 24
  const marginBottom = 28
  const plotWidth = viewWidth - marginLeft - marginRight
  const plotHeight = viewHeight - marginTop - marginBottom

  const maxValue = values.reduce((m, v) => Math.max(m, v), 0)
  const slotWidth = plotWidth / Math.max(buckets.length, 1)
  const ticks = maxValue === 0 ? [0] : [0, maxValue / 3, (maxValue * 2) / 3, maxValue]
  const labelStride = buckets.length > 12 ? Math.ceil(buckets.length / 8) : 1
  const yForTick = (v: number) =>
    maxValue === 0 ? marginTop + plotHeight : marginTop + plotHeight - (v / maxValue) * plotHeight

  const tooltip = hoveredIndex === null ? null : (() => {
    const value = values[hoveredIndex]
    const text = `${buckets[hoveredIndex].label}: ${formatPeso(value)}`
    const boxWidth = Math.max(60, text.length * 6.2 + 16)
    const boxHeight = 22
    const slotStart = marginLeft + hoveredIndex * slotWidth
    const barHeight = maxValue === 0 ? 0 : (value / maxValue) * plotHeight
    const barTop = marginTop + plotHeight - barHeight
    const x = Math.min(Math.max(slotStart + slotWidth / 2 - boxWidth / 2, 2), viewWidth - 2 - boxWidth)
    const aboveY = barTop - boxHeight - 6
    const y = aboveY >= 2 ? aboveY : barTop + 6
    return { x, y, boxWidth, boxHeight, text }
  })()

  return (
    <div className="space-y-2">
      <svg
        viewBox={`0 0 ${viewWidth} ${viewHeight}`}
        preserveAspectRatio="xMidYMid meet"
        className="h-auto w-full"
        role="img"
        aria-label="Revenue over time"
      >
        {ticks.map((t, i) => (
          <g key={i}>
            <line
              x1={marginLeft}
              x2={viewWidth - marginRight}
              y1={yForTick(t)}
              y2={yForTick(t)}
              className="stroke-line"
              strokeWidth={1}
            />
            <text x={marginLeft - 8} y={yForTick(t) + 3} textAnchor="end" className="fill-ink-500 text-xs">
              {formatPeso(t)}
            </text>
          </g>
        ))}

        {buckets.map((b, i) => {
          const slotStart = marginLeft + i * slotWidth
          const barWidth = Math.max(slotWidth - 2, 1)
          const barX = slotStart + (slotWidth - barWidth) / 2
          const value = values[i]
          const barHeight = maxValue === 0 ? 0 : (value / maxValue) * plotHeight
          const barY = marginTop + plotHeight - barHeight
          const barBottom = marginTop + plotHeight

          return (
            <g key={i}>
              {barHeight > 0 && (
                <>
                  <rect x={barX} y={barY} width={barWidth} height={barHeight} rx={4} ry={4} className="fill-current text-brand-600" />
                  {barHeight >= 8 && (
                    <rect x={barX} y={barBottom - 4} width={barWidth} height={4} className="fill-current text-brand-600" />
                  )}
                </>
              )}
              {i % labelStride === 0 && (
                <text x={slotStart + slotWidth / 2} y={viewHeight - marginBottom + 16} textAnchor="middle" className="fill-ink-500 text-xs">
                  {b.label}
                </text>
              )}
              <rect
                x={slotStart}
                y={marginTop}
                width={slotWidth}
                height={plotHeight}
                fill="transparent"
                tabIndex={0}
                onMouseEnter={() => setHoveredIndex(i)}
                onFocus={() => setHoveredIndex(i)}
                onMouseLeave={() => setHoveredIndex(null)}
                onBlur={() => setHoveredIndex(null)}
              >
                <title>{b.label}: {formatPeso(value)}</title>
              </rect>
            </g>
          )
        })}

        {tooltip && (
          <g pointerEvents="none">
            <rect x={tooltip.x} y={tooltip.y} width={tooltip.boxWidth} height={tooltip.boxHeight} rx={4} className="fill-ink-900" />
            <text
              x={tooltip.x + tooltip.boxWidth / 2}
              y={tooltip.y + tooltip.boxHeight / 2 + 3}
              textAnchor="middle"
              className="fill-white text-xs tabular-nums"
            >
              {tooltip.text}
            </text>
          </g>
        )}
      </svg>

      <details className="text-sm">
        <summary className="cursor-pointer text-ink-500">View data</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th scope="col" className="py-1 text-left font-medium text-ink-500">Period</th>
                <th scope="col" className="py-1 text-right font-medium text-ink-500">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((b, i) => (
                <tr key={i} className="border-t border-line">
                  <td className="py-1">{b.label}</td>
                  <td className="py-1 text-right tabular-nums">{formatPeso(values[i])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}

interface TopItemsChartProps {
  items: TopItem[]
}

function TopItemsChart({ items }: TopItemsChartProps) {
  const [hoveredRow, setHoveredRow] = useState<number | null>(null)

  if (items.length === 0) {
    return <p className="text-sm text-ink-500">No items sold in this range.</p>
  }

  const viewWidth = 640
  const labelColWidth = 132
  const marginRight = 8
  const marginTop = 8
  const marginBottomAxis = 24
  const barThickness = 16
  const rowHeight = 28
  const plotWidth = viewWidth - labelColWidth - marginRight
  const plotHeight = items.length * rowHeight
  const viewHeight = marginTop + plotHeight + marginBottomAxis

  const maxAmount = items.reduce((m, it) => Math.max(m, it.amount), 0)
  const ticks = maxAmount === 0 ? [0] : [0, maxAmount / 3, (maxAmount * 2) / 3, maxAmount]
  const xForValue = (v: number) => labelColWidth + (maxAmount === 0 ? 0 : (v / maxAmount) * plotWidth)

  const tooltip = hoveredRow === null ? null : (() => {
    const item = items[hoveredRow]
    const text = `${item.name}: ${formatPeso(item.amount)}`
    const boxWidth = Math.max(70, text.length * 6.2 + 16)
    const boxHeight = 22
    const rowTop = marginTop + hoveredRow * rowHeight
    const barWidth = maxAmount === 0 ? 0 : (item.amount / maxAmount) * plotWidth
    const preferredX = labelColWidth + barWidth + 6
    const x = Math.max(Math.min(preferredX, viewWidth - 2 - boxWidth), labelColWidth)
    const y = rowTop + (rowHeight - boxHeight) / 2
    return { x, y, boxWidth, boxHeight, text }
  })()

  return (
    <div className="space-y-2">
      <svg
        viewBox={`0 0 ${viewWidth} ${viewHeight}`}
        preserveAspectRatio="xMidYMid meet"
        className="h-auto w-full"
        role="img"
        aria-label="Top items by revenue"
      >
        {ticks.map((t, i) => (
          <g key={i}>
            <line
              x1={xForValue(t)}
              x2={xForValue(t)}
              y1={marginTop}
              y2={marginTop + plotHeight}
              className="stroke-line"
              strokeWidth={1}
            />
            <text
              x={xForValue(t)}
              y={marginTop + plotHeight + 16}
              textAnchor={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'}
              className="fill-ink-500 text-xs"
            >
              {formatPeso(t)}
            </text>
          </g>
        ))}

        {items.map((it, i) => {
          const rowTop = marginTop + i * rowHeight
          const barY = rowTop + (rowHeight - barThickness) / 2
          const barWidth = maxAmount === 0 ? 0 : (it.amount / maxAmount) * plotWidth

          return (
            <g key={it.name}>
              <text x={labelColWidth - 8} y={rowTop + rowHeight / 2 + 3} textAnchor="end" className="fill-ink-500 text-xs">
                {truncateLabel(it.name, 18)}
              </text>
              {barWidth > 0 && (
                <>
                  <rect x={labelColWidth} y={barY} width={barWidth} height={barThickness} rx={4} ry={4} className="fill-current text-brand-600" />
                  {barWidth >= 8 && (
                    <rect x={labelColWidth} y={barY} width={4} height={barThickness} className="fill-current text-brand-600" />
                  )}
                </>
              )}
              <rect
                x={0}
                y={rowTop}
                width={viewWidth}
                height={rowHeight}
                fill="transparent"
                tabIndex={0}
                onMouseEnter={() => setHoveredRow(i)}
                onFocus={() => setHoveredRow(i)}
                onMouseLeave={() => setHoveredRow(null)}
                onBlur={() => setHoveredRow(null)}
              >
                <title>{it.name}: {formatPeso(it.amount)}</title>
              </rect>
            </g>
          )
        })}

        {tooltip && (
          <g pointerEvents="none">
            <rect x={tooltip.x} y={tooltip.y} width={tooltip.boxWidth} height={tooltip.boxHeight} rx={4} className="fill-ink-900" />
            <text
              x={tooltip.x + tooltip.boxWidth / 2}
              y={tooltip.y + tooltip.boxHeight / 2 + 3}
              textAnchor="middle"
              className="fill-white text-xs tabular-nums"
            >
              {tooltip.text}
            </text>
          </g>
        )}
      </svg>

      <details className="text-sm">
        <summary className="cursor-pointer text-ink-500">View data</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th scope="col" className="py-1 text-left font-medium text-ink-500">Item</th>
                <th scope="col" className="py-1 text-right font-medium text-ink-500">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.name} className="border-t border-line">
                  <td className="py-1">{it.name}</td>
                  <td className="py-1 text-right tabular-nums">{formatPeso(it.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}
