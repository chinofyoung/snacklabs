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

export function partitionByStock<T extends Pick<Item, 'stock'>>(
  items: T[],
): { inStock: T[]; outOfStock: T[] } {
  const inStock: T[] = []
  const outOfStock: T[] = []
  for (const item of items) {
    // Same coercion the functions above use: Postgres numeric/int columns can
    // arrive as strings over the wire. `> 0` already rejects NaN; the isFinite
    // check is what keeps +Infinity out of inStock. Note this is stricter than
    // ItemCard's own `stock <= 0` test, so a non-finite value would group here
    // as out of stock while still rendering a buyable card — see the deferred
    // note about sharing one predicate between the two.
    const stock = Number(item.stock)
    if (Number.isFinite(stock) && stock > 0) inStock.push(item)
    else outOfStock.push(item)
  }
  return { inStock, outOfStock }
}
