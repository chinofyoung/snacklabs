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

// Ids of the items that are out of stock right now. Built on partitionByStock so
// "out of stock" keeps exactly one definition.
export function outOfStockIds<T extends Pick<Item, 'id' | 'stock'>>(items: T[]): Set<string> {
  return new Set(partitionByStock(items).outOfStock.map((item) => item.id))
}

// Which group each item sat in (true = out of stock) at the moment the list was
// fetched in full. Group MEMBERSHIP is frozen to this between refetches so a row
// does not jump the moment its stock is tapped to 0 -- the next tap would land on
// whatever slid up into its place. Stock numbers stay live; only the grouping is held.
export function snapshotGroups<T extends Pick<Item, 'id' | 'stock'>>(rows: T[]): Map<string, boolean> {
  const outIds = outOfStockIds(rows)
  return new Map(rows.map((row) => [row.id, outIds.has(row.id)]))
}

// Splits `items` into the groups the snapshot recorded, keeping their order. Every
// item lands in exactly one group: one the snapshot has never seen (created without
// a refetch, say) is placed by its live stock instead of being dropped. A snapshot
// entry whose item is gone is simply never visited.
//
// `??`, not `||`: a recorded `false` ("was in stock") is a real answer. With `||` it
// would fall through to live stock, so an item tapped to 0 would jump groups anyway.
export function groupFromSnapshot<T extends Pick<Item, 'id' | 'stock'>>(
  items: T[],
  snapshot: ReadonlyMap<string, boolean>,
): { inStock: T[]; outOfStock: T[] } {
  const liveOut = outOfStockIds(items)
  const inStock: T[] = []
  const outOfStock: T[] = []
  for (const item of items) {
    const out = snapshot.get(item.id) ?? liveOut.has(item.id)
    ;(out ? outOfStock : inStock).push(item)
  }
  return { inStock, outOfStock }
}
