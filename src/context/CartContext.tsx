import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { CartLine, Item } from '../types'
import { addToCart, setQty, cartTotal, cartCount } from '../lib/cart'

interface CartState {
  lines: CartLine[]
  add: (item: Item) => void
  setLineQty: (itemId: string, qty: number) => void
  clear: () => void
  total: number
  count: number
}

const CartContext = createContext<CartState | null>(null)
const STORAGE_KEY = 'snacklabs.cart'

export function CartProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  })

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(lines))
  }, [lines])

  return (
    <CartContext.Provider
      value={{
        lines,
        add: (item) => setLines((l) => addToCart(l, item)),
        setLineQty: (id, qty) => setLines((l) => setQty(l, id, qty)),
        clear: () => setLines([]),
        total: cartTotal(lines),
        count: cartCount(lines),
      }}
    >
      {children}
    </CartContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useCart() {
  const ctx = useContext(CartContext)
  if (!ctx) throw new Error('useCart outside CartProvider')
  return ctx
}
