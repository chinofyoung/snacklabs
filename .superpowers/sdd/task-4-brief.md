### Task 4: Domain types + cart logic (TDD) + cart context

**Files:**
- Create: `src/types.ts`, `src/lib/cart.ts`, `src/context/CartContext.tsx`
- Test: `src/lib/cart.test.ts`

**Interfaces:**
- Produces:
  - `src/types.ts`: `Item`, `PaymentMethod`, `Order`, `OrderStatus`, `OrderItem`, `RestockSession`, `AiVerdict`, `CartLine` (shapes below — later tasks import these).
  - `src/lib/cart.ts`: `addToCart(lines, item)`, `setQty(lines, itemId, qty)` (qty ≤ 0 removes the line; qty clamped to item stock), `cartTotal(lines): number`, `cartCount(lines): number`. All pure, return new arrays.
  - `src/context/CartContext.tsx`: `useCart(): { lines: CartLine[]; add(item: Item): void; setLineQty(itemId: string, qty: number): void; clear(): void; total: number; count: number }`, persisted to `localStorage` key `snacklabs.cart`.

- [ ] **Step 1: Types**

`src/types.ts`:

```ts
export interface Item {
  id: string
  name: string
  price: number
  stock: number
  image_url: string | null
  category: string
  low_stock_threshold: number
  is_active: boolean
}

export interface PaymentMethod {
  id: string
  label: string
  type: 'ewallet' | 'bank'
  qr_image_url: string
  account_name: string
  account_number: string
  is_active: boolean
}

export type OrderStatus =
  | 'awaiting_payment' | 'verifying' | 'paid' | 'needs_review' | 'cancelled'

export interface AiVerdict {
  verdict: 'pass' | 'fail' | 'unsure'
  extracted: {
    amount: number | null
    recipient: string | null
    reference: string | null
    timestamp: string | null
  }
  reason: string
}

export interface Order {
  id: string
  user_id: string
  total: number
  status: OrderStatus
  payment_method_id: string | null
  receipt_image_url: string | null
  ai_verdict: AiVerdict | null
  created_at: string
}

export interface OrderItem {
  order_id: string
  item_id: string
  qty: number
  price_at_purchase: number
}

export interface RestockDetection {
  matched_item_id: string | null
  name: string
  qty: number
  suggested_price: number | null
  confidence: 'high' | 'medium' | 'low'
}

export interface RestockSession {
  id: string
  admin_id: string
  photo_url: string
  ai_result: { detections: RestockDetection[] } | null
  status: 'pending_review' | 'applied' | 'discarded'
  created_at: string
}

export interface CartLine {
  item: Item
  qty: number
}
```

- [ ] **Step 2: Write failing cart tests**

`src/lib/cart.test.ts`:

```ts
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
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test` → FAIL: `Cannot find module './cart'`.

- [ ] **Step 4: Implement `src/lib/cart.ts`**

```ts
import type { CartLine, Item } from '../types'

export function addToCart(lines: CartLine[], item: Item): CartLine[] {
  const existing = lines.find((l) => l.item.id === item.id)
  if (!existing) return [...lines, { item, qty: 1 }]
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test` → PASS (all cart + money tests).

- [ ] **Step 6: Cart context**

`src/context/CartContext.tsx`:

```tsx
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
      return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
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
```

Wrap `<App />` with `<CartProvider>` inside `<AuthProvider>` in `src/main.tsx`.

- [ ] **Step 7: Verify**

Run: `npm run test` → PASS. Run: `npm run build` → succeeds.

---

