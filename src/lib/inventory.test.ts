import { describe, it, expect } from 'vitest'
import {
  groupFromSnapshot, outOfStockIds, partitionByStock, projectedSales, remainingUnits, snapshotGroups,
} from './inventory'

describe('projectedSales', () => {
  it('returns 0 for an empty array', () => {
    expect(projectedSales([])).toBe(0)
  })

  it('computes price times stock for a single item', () => {
    expect(projectedSales([{ price: 10, stock: 5 }])).toBe(50)
  })

  it('sums price times stock across multiple items', () => {
    expect(projectedSales([
      { price: 10, stock: 5 },
      { price: 2, stock: 3 },
    ])).toBe(56)
  })

  it('a zero-stock item contributes nothing', () => {
    expect(projectedSales([
      { price: 10, stock: 5 },
      { price: 999, stock: 0 },
    ])).toBe(50)
  })

  it('handles fractional prices', () => {
    expect(projectedSales([{ price: 12.5, stock: 3 }])).toBe(37.5)
  })

  it('coerces numeric-as-string price and stock', () => {
    expect(projectedSales([
      { price: '12.50' as unknown as number, stock: '3' as unknown as number },
    ])).toBe(37.5)
  })

  it('a non-finite item contributes 0 without poisoning the rest of the sum', () => {
    expect(projectedSales([
      { price: 10, stock: 5 },
      { price: NaN, stock: 3 },
      { price: undefined as unknown as number, stock: 2 },
      { price: 2, stock: 4 },
    ])).toBe(58)
  })

  it('does not mutate the input array or its items', () => {
    const items = [{ price: 10, stock: 5 }, { price: 2, stock: 3 }]
    const before = JSON.parse(JSON.stringify(items))
    projectedSales(items)
    expect(items).toEqual(before)
  })
})

describe('remainingUnits', () => {
  it('returns 0 for an empty array', () => {
    expect(remainingUnits([])).toBe(0)
  })

  it('returns the stock for a single item', () => {
    expect(remainingUnits([{ stock: 5 }])).toBe(5)
  })

  it('sums stock across multiple items', () => {
    expect(remainingUnits([{ stock: 5 }, { stock: 3 }])).toBe(8)
  })

  it('a zero-stock item contributes nothing', () => {
    expect(remainingUnits([{ stock: 0 }, { stock: 4 }])).toBe(4)
  })

  it('coerces numeric-as-string stock', () => {
    expect(remainingUnits([{ stock: '7' as unknown as number }])).toBe(7)
  })

  it('a non-finite item contributes 0 without poisoning the rest of the sum', () => {
    expect(remainingUnits([
      { stock: 5 },
      { stock: NaN },
      { stock: undefined as unknown as number },
      { stock: 3 },
    ])).toBe(8)
  })

  it('does not mutate the input array or its items', () => {
    const items = [{ stock: 5 }, { stock: 3 }]
    const before = JSON.parse(JSON.stringify(items))
    remainingUnits(items)
    expect(items).toEqual(before)
  })
})

const item = (name: string, stock: number) =>
  ({ id: name, name, price: 10, stock, image_url: null, category: 'snacks',
     low_stock_threshold: 2, is_active: true })

describe('partitionByStock', () => {
  it('puts in-stock items first and out-of-stock items second', () => {
    const { inStock, outOfStock } = partitionByStock([
      item('a', 0), item('b', 5), item('c', 0), item('d', 1),
    ])
    expect(inStock.map((i) => i.name)).toEqual(['b', 'd'])
    expect(outOfStock.map((i) => i.name)).toEqual(['a', 'c'])
  })

  it('preserves the incoming order within each group', () => {
    const { inStock } = partitionByStock([item('z', 3), item('a', 3)])
    expect(inStock.map((i) => i.name)).toEqual(['z', 'a'])
  })

  it('treats negative stock as out of stock', () => {
    const { outOfStock } = partitionByStock([item('a', -1)])
    expect(outOfStock.map((i) => i.name)).toEqual(['a'])
  })

  it('treats a non-finite stock value as out of stock rather than in stock', () => {
    const { inStock, outOfStock } = partitionByStock([
      { ...item('bad', 0), stock: NaN as unknown as number },
    ])
    expect(inStock).toHaveLength(0)
    expect(outOfStock.map((i) => i.name)).toEqual(['bad'])
  })

  it('treats an infinite stock value as out of stock', () => {
    const { inStock, outOfStock } = partitionByStock([
      { ...item('huge', 0), stock: Infinity as unknown as number },
    ])
    expect(inStock).toHaveLength(0)
    expect(outOfStock.map((i) => i.name)).toEqual(['huge'])
  })

  it('handles stock arriving as a numeric string', () => {
    const { inStock } = partitionByStock([
      { ...item('a', 0), stock: '4' as unknown as number },
    ])
    expect(inStock.map((i) => i.name)).toEqual(['a'])
  })

  it('returns two empty groups for an empty list', () => {
    expect(partitionByStock([])).toEqual({ inStock: [], outOfStock: [] })
  })
})

describe('outOfStockIds', () => {
  it('collects the ids of items that are out of stock right now', () => {
    expect(outOfStockIds([item('a', 0), item('b', 2), item('c', -1)])).toEqual(new Set(['a', 'c']))
  })

  it('is empty when everything is in stock, or when there are no items', () => {
    expect(outOfStockIds([item('a', 1)]).size).toBe(0)
    expect(outOfStockIds([]).size).toBe(0)
  })
})

describe('snapshotGroups', () => {
  it('records true for out-of-stock rows and false for in-stock rows', () => {
    const snap = snapshotGroups([item('a', 2), item('b', 0), item('c', -3)])
    expect(snap.get('a')).toBe(false)
    expect(snap.get('b')).toBe(true)
    expect(snap.get('c')).toBe(true)
    expect(snap.size).toBe(3)
  })

  it('is empty for no rows', () => {
    expect(snapshotGroups([]).size).toBe(0)
  })
})

describe('groupFromSnapshot', () => {
  const loaded = [item('a', 2), item('b', 1), item('c', 5), item('d', 0), item('e', 0)]
  const snap = snapshotGroups(loaded)
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id)

  it('keeps an item tapped to 0 in the in-stock group, in order', () => {
    const now = loaded.map((i) => (i.id === 'b' ? { ...i, stock: 0 } : i))
    const { inStock, outOfStock } = groupFromSnapshot(now, snap)
    expect(ids(inStock)).toEqual(['a', 'b', 'c'])
    expect(ids(outOfStock)).toEqual(['d', 'e'])
  })

  it('keeps an item topped up from 0 in the out-of-stock group', () => {
    const now = loaded.map((i) => (i.id === 'd' ? { ...i, stock: 4 } : i))
    const { inStock, outOfStock } = groupFromSnapshot(now, snap)
    expect(ids(outOfStock)).toEqual(['d', 'e'])
    expect(ids(inStock)).toEqual(['a', 'b', 'c'])
  })

  it('places ids absent from the snapshot by live stock and never drops them', () => {
    const now = [...loaded, item('new-in', 3), item('new-out', 0), item('neg', -2)]
    const { inStock, outOfStock } = groupFromSnapshot(now, snap)
    expect(ids(inStock)).toEqual(['a', 'b', 'c', 'new-in'])
    expect(ids(outOfStock)).toEqual(['d', 'e', 'new-out', 'neg'])
    expect(inStock.length + outOfStock.length).toBe(now.length)
  })

  it('puts every item in exactly one group for any mix of snapshot entries and live stock', () => {
    // 3 stock levels x (absent | recorded in | recorded out) per item, exhaustively.
    const stocks = [3, 0, -2]
    const recorded: (boolean | undefined)[] = [undefined, false, true]
    for (const a of recorded) for (const b of recorded) for (const c of recorded) {
      const now = stocks.map((stock, n) => item(`i${n}`, stock))
      const snapshot = new Map<string, boolean>()
      ;[a, b, c].forEach((r, n) => { if (r !== undefined) snapshot.set(`i${n}`, r) })
      const { inStock, outOfStock } = groupFromSnapshot(now, snapshot)
      expect(inStock.length + outOfStock.length).toBe(now.length)
      expect([...ids(inStock), ...ids(outOfStock)].sort()).toEqual(ids(now).sort())
      // ...and in the right one: a recorded entry (even `false`) wins over live
      // stock, and only an absent one falls back to it.
      const expectedOut = [a, b, c].map((r, n) => (r === undefined ? stocks[n] <= 0 : r))
      expect(ids(outOfStock)).toEqual(ids(now).filter((_, n) => expectedOut[n]))
    }
  })

  it('gives the same result as partitionByStock when the snapshot is empty', () => {
    const grouped = groupFromSnapshot(loaded, new Map())
    const partitioned = partitionByStock(loaded)
    expect(ids(grouped.inStock)).toEqual(ids(partitioned.inStock))
    expect(ids(grouped.outOfStock)).toEqual(ids(partitioned.outOfStock))
  })

  it('regroups from the rows when the snapshot is taken fresh after a refetch', () => {
    const refetched = [item('a', 2), item('b', 0), item('c', 5), item('d', 3), item('e', 0)]
    const { inStock, outOfStock } = groupFromSnapshot(refetched, snapshotGroups(refetched))
    expect(ids(inStock)).toEqual(['a', 'c', 'd'])
    expect(ids(outOfStock)).toEqual(['b', 'e'])
  })

  it('ignores a snapshot entry whose item is no longer in the list', () => {
    const now = loaded.filter((i) => i.id !== 'b' && i.id !== 'd')
    const { inStock, outOfStock } = groupFromSnapshot(now, snap)
    expect(ids(inStock)).toEqual(['a', 'c'])
    expect(ids(outOfStock)).toEqual(['e'])
    expect(inStock.length + outOfStock.length).toBe(now.length)
  })

  it('does not mutate the items or the snapshot', () => {
    const before = JSON.stringify(loaded)
    const snapBefore = [...snap.entries()]
    groupFromSnapshot(loaded, snap)
    expect(JSON.stringify(loaded)).toBe(before)
    expect([...snap.entries()]).toEqual(snapBefore)
  })
})
