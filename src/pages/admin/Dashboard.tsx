import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { PartyPopper, Sparkles } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { formatPeso } from '../../lib/money'
import type { Item, Order } from '../../types'

export default function Dashboard() {
  const [todaySales, setTodaySales] = useState(0)
  const [reviewCount, setReviewCount] = useState(0)
  const [lowStock, setLowStock] = useState<Item[]>([])
  const [aiTodayPhp, setAiTodayPhp] = useState(0)
  const [aiTotalPhp, setAiTotalPhp] = useState(0)
  const [aiCount, setAiCount] = useState(0)

  useEffect(() => {
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)

    supabase.from('orders').select('total')
      .eq('status', 'paid').gte('created_at', startOfDay.toISOString())
      .then(({ data }) =>
        setTodaySales(((data as Pick<Order, 'total'>[]) ?? []).reduce((s, o) => s + Number(o.total), 0)))

    supabase.from('orders').select('id', { count: 'exact', head: true })
      .eq('status', 'needs_review')
      .then(({ count }) => setReviewCount(count ?? 0))

    supabase.from('items').select('*').eq('is_active', true)
      .then(({ data }) =>
        setLowStock(((data as Item[]) ?? []).filter((i) => i.stock <= i.low_stock_threshold)))

    supabase.from('ai_usage').select('cost_php, created_at')
      .then(({ data }) => {
        const rows = (data as { cost_php: number; created_at: string }[]) ?? []
        setAiTotalPhp(rows.reduce((s, r) => s + Number(r.cost_php), 0))
        setAiTodayPhp(rows.filter(r => r.created_at >= startOfDay.toISOString()).reduce((s, r) => s + Number(r.cost_php), 0))
        setAiCount(rows.length)
      })
  }, [])

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-3xl">
      <h1 className="font-display text-2xl font-bold">Dashboard</h1>
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg bg-surface-raised p-5 shadow-card">
          <p className="text-sm text-ink-500">Sales today</p>
          <p className="text-2xl font-black text-brand-600 tabular-nums">{formatPeso(todaySales)}</p>
        </div>
        <Link to="/admin/orders?filter=needs_review" className="rounded-lg bg-surface-raised p-5 shadow-card transition hover:shadow-none">
          <p className="text-sm text-ink-500">Needs review</p>
          <p className={`text-2xl font-black tabular-nums ${reviewCount > 0 ? 'text-amber-600' : 'text-ink-900'}`}>{reviewCount}</p>
        </Link>
        <div className="rounded-lg bg-surface-raised p-5 shadow-card col-span-2">
          <p className="text-sm text-ink-500 flex items-center gap-1">
            <Sparkles className="size-3.5" strokeWidth={2.5} aria-hidden="true" /> AI cost today
          </p>
          <p className="text-2xl font-black text-brand-600 tabular-nums">{formatPeso(aiTodayPhp)}</p>
          <p className="text-xs text-ink-500 mt-1">
            all-time {formatPeso(aiTotalPhp)} · {aiCount} calls · at ₱58.50 / $1
          </p>
        </div>
      </div>
      <section className="space-y-2">
        <h2 className="font-semibold text-sm text-ink-700">Low stock</h2>
        {lowStock.length === 0 ? (
          <p className="text-sm text-ink-500 flex items-center gap-1">
            All stocked up <PartyPopper className="size-4" strokeWidth={2.5} aria-hidden="true" />
          </p>
        ) : (
          lowStock.map((i) => (
            <div key={i.id} className="rounded-md bg-surface-raised p-3 shadow-card flex justify-between text-sm">
              <span>{i.name}</span>
              <span className="font-bold text-amber-600 tabular-nums">{i.stock} left</span>
            </div>
          ))
        )}
      </section>
    </div>
  )
}
