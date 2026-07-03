import type { CartLine, Item } from '../types'

export function addToCart(lines: CartLine[], item: Item): CartLine[] {
  const existing = lines.find((l) => l.item.id === item.id)
  if (!existing) {
    if (item.stock <= 0) return lines
    return [...lines, { item, qty: 1 }]
  }
  return setQty(lines, item.id, existing.qty + 1)
}

export function setQty(lines: CartLine[], itemId: string, qty: number): CartLine[] {
  if (qty <= 0) return lines.filter((l) => l.item.id !== itemId)
  return lines.map((l) =>
    l.item.id === itemId ? { ...l, qty: Math.min(qty, l.item.stock) } : l,
  )
}

export function cartTotal(lines: CartLine[]): number {
  return lines.reduce((sum, l) => sum + l.item.price * l.qty, 0)
}

export function cartCount(lines: CartLine[]): number {
  return lines.reduce((sum, l) => sum + l.qty, 0)
}
