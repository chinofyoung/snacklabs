### Task 5: Customer store page

**Files:**
- Create: `src/pages/Store.tsx`, `src/components/ItemCard.tsx`, `src/components/CartBar.tsx`
- Modify: `src/App.tsx` (replace `/` placeholder with `<Store />`)

**Interfaces:**
- Consumes: `useCart()`, `useAuth()`, `supabase`, `formatPeso`, `Item`.
- Produces: routes `/` renders the store. `CartBar` links to `/cart` (Task 6).

- [ ] **Step 1: ItemCard**

`src/components/ItemCard.tsx`:

```tsx
import type { Item } from '../types'
import { formatPeso } from '../lib/money'
import { useCart } from '../context/CartContext'

export default function ItemCard({ item }: { item: Item }) {
  const { add, lines } = useCart()
  const inCart = lines.find((l) => l.item.id === item.id)?.qty ?? 0
  const out = item.stock <= 0
  const maxed = inCart >= item.stock

  return (
    <div className={`rounded-2xl bg-white shadow-sm overflow-hidden flex flex-col ${out ? 'opacity-50' : ''}`}>
      <div className="aspect-square bg-brand-50 flex items-center justify-center">
        {item.image_url
          ? <img src={item.image_url} alt={item.name} className="w-full h-full object-cover" />
          : <span className="text-4xl">🛒</span>}
      </div>
      <div className="p-3 flex flex-col gap-1 grow">
        <p className="font-medium text-sm leading-tight">{item.name}</p>
        <p className="text-brand-600 font-bold">{formatPeso(item.price)}</p>
        <p className="text-xs text-ink-500">{out ? 'Out of stock' : `${item.stock} left`}</p>
        <button
          disabled={out || maxed}
          onClick={() => add(item)}
          className="mt-auto rounded-lg bg-ink-900 text-white text-sm py-2 disabled:bg-stone-300 active:scale-95 transition"
        >
          {inCart > 0 ? `In cart · ${inCart}` : 'Add'}
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: CartBar**

`src/components/CartBar.tsx`:

```tsx
import { Link } from 'react-router'
import { useCart } from '../context/CartContext'
import { formatPeso } from '../lib/money'

export default function CartBar() {
  const { count, total } = useCart()
  if (count === 0) return null
  return (
    <Link
      to="/cart"
      className="fixed bottom-4 inset-x-4 max-w-md mx-auto rounded-2xl bg-brand-600 text-white px-5 py-3.5 flex items-center justify-between shadow-lg active:scale-[0.98] transition"
    >
      <span className="font-medium">{count} item{count > 1 ? 's' : ''}</span>
      <span className="font-bold">{formatPeso(total)} · View cart →</span>
    </Link>
  )
}
```

- [ ] **Step 3: Store page**

`src/pages/Store.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { supabase } from '../lib/supabase'
import type { Item } from '../types'
import ItemCard from '../components/ItemCard'
import CartBar from '../components/CartBar'
import { useAuth } from '../context/AuthContext'

export default function Store() {
  const { profile, signOut } = useAuth()
  const [items, setItems] = useState<Item[]>([])
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.from('items').select('*').eq('is_active', true).order('name')
      .then(({ data }) => { setItems((data as Item[]) ?? []); setLoading(false) })
  }, [])

  const categories = useMemo(
    () => [...new Set(items.map((i) => i.category))].sort(),
    [items],
  )
  const visible = items.filter((i) =>
    (!category || i.category === category) &&
    i.name.toLowerCase().includes(search.toLowerCase()),
  )

  return (
    <div className="max-w-md mx-auto min-h-dvh pb-28">
      <header className="sticky top-0 z-10 bg-surface/90 backdrop-blur px-4 pt-4 pb-2 space-y-3">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold">🍿 SnackLabs</h1>
          <div className="flex items-center gap-3 text-sm">
            <Link to="/orders" className="text-ink-500">My orders</Link>
            {profile?.is_admin && <Link to="/admin" className="text-brand-600 font-medium">Admin</Link>}
            <button onClick={signOut} className="text-ink-500">Sign out</button>
          </div>
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search snacks…"
          className="w-full rounded-xl bg-white px-4 py-2.5 text-sm shadow-sm outline-none focus:ring-2 ring-brand-500"
        />
        <div className="flex gap-2 overflow-x-auto pb-1">
          <Chip active={!category} onClick={() => setCategory(null)}>All</Chip>
          {categories.map((c) => (
            <Chip key={c} active={category === c} onClick={() => setCategory(c)}>{c}</Chip>
          ))}
        </div>
      </header>

      {loading ? (
        <p className="p-8 text-center text-ink-500">Loading the shelf…</p>
      ) : visible.length === 0 ? (
        <p className="p-8 text-center text-ink-500">Nothing here yet.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 px-4 pt-2">
          {visible.map((i) => <ItemCard key={i.id} item={i} />)}
        </div>
      )}
      <CartBar />
    </div>
  )
}

function Chip({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm capitalize transition ${
        active ? 'bg-ink-900 text-white' : 'bg-white text-ink-500 shadow-sm'
      }`}
    >
      {children}
    </button>
  )
}
```

- [ ] **Step 4: Route it**

In `src/App.tsx`, replace the `/` placeholder: `<Route path="/" element={<RequireAuth><Store /></RequireAuth>} />`.

- [ ] **Step 5: Verify**

Run: `npm run build` → succeeds. Seed 2–3 items via SQL editor (`insert into items (name, price, stock, category) values ('Piattos', 25, 10, 'snacks'), ('Coke Zero', 35, 6, 'drinks');`), then `npm run dev`: items render, search and chips filter, adding shows the cart bar, out-of-stock item (stock 0) is greyed.

---

