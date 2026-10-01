import { describe, it, expect } from 'vitest'
import { partitionByStock, projectedSales, remainingUnits } from './inventory'

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

describe('partitionByStock', () => {
  const item = (name: string, stock: number) =>
    ({ id: name, name, price: 10, stock, image_url: null, category: 'snacks',
       low_stock_threshold: 2, is_active: true })

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
