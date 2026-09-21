import type { Item } from '../types'

export function projectedSales(items: Pick<Item, 'price' | 'stock'>[]): number {
  return items.reduce((sum, item) => {
    // Postgres numeric/int columns can arrive as strings over the wire (see
    // Dashboard.tsx), so coerce before multiplying. A non-finite result
    // (NaN, Infinity - e.g. from a missing or garbage value) is excluded
    // rather than letting it poison the whole sum.
    const price = Number(item.price)
    const stock = Number(item.stock)
    if (!Number.isFinite(price) || !Number.isFinite(stock)) return sum
    return sum + price * stock
  }, 0)
}

export function remainingUnits(items: Pick<Item, 'stock'>[]): number {
  return items.reduce((sum, item) => {
    const stock = Number(item.stock)
    if (!Number.isFinite(stock)) return sum
    return sum + stock
  }, 0)
}
