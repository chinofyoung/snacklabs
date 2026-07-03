### Task 6: Cart, checkout & QR payment screen

**Files:**
- Create: `src/pages/Cart.tsx`, `src/pages/Pay.tsx`
- Modify: `src/App.tsx` (add routes `/cart`, `/pay/:orderId`)

**Interfaces:**
- Consumes: `useCart()`, `supabase.rpc('create_order', ...)`, `PaymentMethod`, `Order`, `formatPeso`.
- Produces: `/cart` (review + choose payment method + place order → navigates to `/pay/:orderId`), `/pay/:orderId` (QR screen; its upload button is wired in Task 8 — for now it renders a disabled "Upload payment screenshot" button with `data-todo="task-8"`).

- [ ] **Step 1: Cart page**

`src/pages/Cart.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { supabase } from '../lib/supabase'
import { useCart } from '../context/CartContext'
import { formatPeso } from '../lib/money'
import type { PaymentMethod } from '../types'

export default function Cart() {
  const { lines, setLineQty, total, clear } = useCart()
  const [methods, setMethods] = useState<PaymentMethod[]>([])
  const [methodId, setMethodId] = useState<string | null>(null)
  const [placing, setPlacing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    supabase.from('payment_methods').select('*').eq('is_active', true)
      .then(({ data }) => {
        const m = (data as PaymentMethod[]) ?? []
        setMethods(m)
        if (m.length > 0) setMethodId(m[0].id)
      })
  }, [])

  const placeOrder = async () => {
    setPlacing(true)
    setError(null)
    const { data, error } = await supabase.rpc('create_order', {
      p_items: lines.map((l) => ({ item_id: l.item.id, qty: l.qty })),
      p_payment_method_id: methodId,
    })
    setPlacing(false)
    if (error) {
      setError(
        error.message.includes('insufficient stock')
          ? 'Someone beat you to it — an item just went out of stock. Adjust your cart.'
          : error.message,
      )
      return
    }
    clear()
    navigate(`/pay/${data}`)
  }

  if (lines.length === 0) {
    return (
      <div className="max-w-md mx-auto min-h-dvh flex flex-col items-center justify-center gap-3">
        <p className="text-ink-500">Your cart is empty.</p>
        <Link to="/" className="text-brand-600 font-medium">← Back to store</Link>
      </div>
    )
  }

  return (
    <div className="max-w-md mx-auto min-h-dvh px-4 py-4 space-y-5">
      <header className="flex items-center gap-3">
        <Link to="/" className="text-ink-500">←</Link>
        <h1 className="text-xl font-bold">Your cart</h1>
      </header>

      <div className="space-y-3">
        {lines.map(({ item, qty }) => (
          <div key={item.id} className="rounded-2xl bg-white p-3 shadow-sm flex items-center gap-3">
            <div className="size-14 rounded-xl bg-brand-50 flex items-center justify-center overflow-hidden">
              {item.image_url
                ? <img src={item.image_url} alt="" className="w-full h-full object-cover" />
                : '🛒'}
            </div>
            <div className="grow">
              <p className="font-medium text-sm">{item.name}</p>
              <p className="text-brand-600 font-bold text-sm">{formatPeso(item.price)}</p>
            </div>
            <div className="flex items-center gap-2">
              <Stepper onClick={() => setLineQty(item.id, qty - 1)}>−</Stepper>
              <span className="w-6 text-center font-medium">{qty}</span>
              <Stepper onClick={() => setLineQty(item.id, qty + 1)}>+</Stepper>
            </div>
          </div>
        ))}
      </div>

      <section className="space-y-2">
        <h2 className="font-semibold">Pay with</h2>
        {methods.length === 0 && (
          <p className="text-sm text-ink-500">No payment methods set up yet — ask your admin.</p>
        )}
        {methods.map((m) => (
          <button
            key={m.id}
            onClick={() => setMethodId(m.id)}
            className={`w-full rounded-xl p-3 text-left flex items-center gap-3 transition ${
              methodId === m.id ? 'bg-ink-900 text-white' : 'bg-white shadow-sm'
            }`}
          >
            <span>{m.type === 'ewallet' ? '📱' : '🏦'}</span>
            <span className="font-medium">{m.label}</span>
          </button>
        ))}
      </section>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        disabled={placing || !methodId}
        onClick={placeOrder}
        className="w-full rounded-2xl bg-brand-600 text-white py-4 font-bold text-lg disabled:bg-stone-300 active:scale-[0.98] transition"
      >
        {placing ? 'Placing order…' : `Pay ${formatPeso(total)}`}
      </button>
    </div>
  )
}

function Stepper({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="size-8 rounded-full bg-stone-100 font-bold active:scale-90 transition">
      {children}
    </button>
  )
}
```

- [ ] **Step 2: Pay page (QR display; upload wired in Task 8)**

`src/pages/Pay.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { supabase } from '../lib/supabase'
import { formatPeso } from '../lib/money'
import type { Order, PaymentMethod } from '../types'

export default function Pay() {
  const { orderId } = useParams()
  const [order, setOrder] = useState<Order | null>(null)
  const [method, setMethod] = useState<PaymentMethod | null>(null)

  useEffect(() => {
    if (!orderId) return
    supabase.from('orders').select('*').eq('id', orderId).single()
      .then(async ({ data }) => {
        const o = data as Order | null
        setOrder(o)
        if (o?.payment_method_id) {
          const { data: pm } = await supabase
            .from('payment_methods').select('*').eq('id', o.payment_method_id).single()
          setMethod(pm as PaymentMethod)
        }
      })
  }, [orderId])

  if (!order) return <div className="min-h-dvh flex items-center justify-center text-ink-500">Loading…</div>

  return (
    <div className="max-w-md mx-auto min-h-dvh px-4 py-4 space-y-5">
      <header className="flex items-center gap-3">
        <Link to="/" className="text-ink-500">←</Link>
        <h1 className="text-xl font-bold">Scan & pay</h1>
      </header>

      <div className="rounded-3xl bg-white p-6 shadow-sm text-center space-y-4">
        <p className="text-ink-500 text-sm">Amount due</p>
        <p className="text-4xl font-black text-brand-600">{formatPeso(order.total)}</p>
        {method && (
          <>
            <img src={method.qr_image_url} alt={`${method.label} QR code`} className="mx-auto w-64 rounded-2xl" />
            <div>
              <p className="font-semibold">{method.label}</p>
              <p className="text-sm text-ink-500">{method.account_name}</p>
            </div>
          </>
        )}
      </div>

      <PaymentStatus order={order} />
    </div>
  )
}

// Replaced in Task 8 with real upload + verification flow.
function PaymentStatus({ order }: { order: Order }) {
  if (order.status !== 'awaiting_payment') {
    return <p className="text-center text-ink-500 capitalize">{order.status.replace('_', ' ')}</p>
  }
  return (
    <button data-todo="task-8" disabled className="w-full rounded-2xl bg-stone-300 text-white py-4 font-bold">
      Upload payment screenshot
    </button>
  )
}
```

- [ ] **Step 3: Routes**

Add to `src/App.tsx`:

```tsx
<Route path="/cart" element={<RequireAuth><Cart /></RequireAuth>} />
<Route path="/pay/:orderId" element={<RequireAuth><Pay /></RequireAuth>} />
```

- [ ] **Step 4: Verify**

Run: `npm run build` → succeeds. Seed a payment method:
`insert into payment_methods (label, type, qr_image_url, account_name) values ('GCash', 'ewallet', 'https://placehold.co/400x400/png?text=QR', 'Snack Labs');`
In the dev app: add items → cart → steppers work → place order → lands on `/pay/:id` showing amount + QR. In SQL editor, confirm the order row: `select id, total, status from orders order by created_at desc limit 1;` → status `awaiting_payment`, total matches.

---

