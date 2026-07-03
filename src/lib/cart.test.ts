import { describe, it, expect } from 'vitest'
import { addToCart, setQty, cartTotal, cartCount } from './cart'
import type { Item, CartLine } from '../types'

const item = (over: Partial<Item> = {}): Item => ({
  id: 'a', name: 'Piattos', price: 25, stock: 5, image_url: null,
  category: 'snacks', low_stock_threshold: 3, is_active: true, ...over,
})

describe('cart', () => {
  it('adds a new item with qty 1', () => {
    const lines = addToCart([], item())
    expect(lines).toEqual([{ item: item(), qty: 1 }])
  })

  it('increments qty when item already in cart', () => {
    const lines = addToCart([{ item: item(), qty: 1 }], item())
    expect(lines[0].qty).toBe(2)
  })

  it('does not exceed stock when adding', () => {
    const lines = addToCart([{ item: item({ stock: 2 }), qty: 2 }], item({ stock: 2 }))
    expect(lines[0].qty).toBe(2)
  })

  it('setQty clamps to stock and removes at zero', () => {
    const start: CartLine[] = [{ item: item({ stock: 3 }), qty: 1 }]
    expect(setQty(start, 'a', 10)[0].qty).toBe(3)
    expect(setQty(start, 'a', 0)).toEqual([])
  })

  it('computes total and count', () => {
    const lines: CartLine[] = [
      { item: item({ id: 'a', price: 25 }), qty: 2 },
      { item: item({ id: 'b', price: 10.5 }), qty: 1 },
    ]
    expect(cartTotal(lines)).toBe(60.5)
    expect(cartCount(lines)).toBe(3)
  })

  it('does not add an out-of-stock item', () => {
    expect(addToCart([], item({ stock: 0 }))).toEqual([])
  })
})
