export interface PaidOrderRow {
  id: string
  user_id: string
  total: number
  created_at: string
  profiles: { full_name: string; email: string } | null
}

export interface BuyerRow {
  userId: string
  name: string
  email: string
  total: number
  orderCount: number
  lastPurchase: string
}

export function rankBuyers(orders: PaidOrderRow[]): BuyerRow[] {
  const byBuyer = new Map<string, BuyerRow>()

  for (const order of orders) {
    // total is typed as number, but postgrest serializes Postgres `numeric`
    // columns as strings over the wire, so it can arrive as a numeric
    // string at runtime despite the compile-time type.
    const total = Number(order.total)
    const existing = byBuyer.get(order.user_id)

    if (existing) {
      existing.total += total
      existing.orderCount += 1
      if (new Date(order.created_at).getTime() > new Date(existing.lastPurchase).getTime()) {
        existing.lastPurchase = order.created_at
      }
      continue
    }

    const fullName = order.profiles?.full_name.trim() ?? ''
    const email = order.profiles?.email ?? ''
    byBuyer.set(order.user_id, {
      userId: order.user_id,
      name: fullName || email || 'Unknown',
      email,
      total,
      orderCount: 1,
      lastPurchase: order.created_at,
    })
  }

  return [...byBuyer.values()].sort((a, b) => {
    if (a.total !== b.total) return b.total - a.total
    if (a.orderCount !== b.orderCount) return b.orderCount - a.orderCount
    return a.name.localeCompare(b.name)
  })
}
