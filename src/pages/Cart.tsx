import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Banknote, Landmark, ShoppingBasket, Smartphone, Trash2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useCart } from '../context/CartContext'
import { formatPeso } from '../lib/money'
import ConfirmDialog from '../components/ConfirmDialog'
import type { CartLine, PaymentMethod } from '../types'

function methodDetail(m: PaymentMethod): string | null {
  const name = m.account_name.trim()
  const number = m.account_number.trim()
  if (name && number) return `${name} · ${number}`
  return name || number || null
}

export default function Cart() {
  const { lines, setLineQty, total, clear, count } = useCart()
  const [methods, setMethods] = useState<PaymentMethod[]>([])
  const [methodId, setMethodId] = useState<string | null>(null)
  const [placing, setPlacing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingRemove, setPendingRemove] = useState<CartLine | null>(null)
  const [confirmingOrder, setConfirmingOrder] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    supabase.from('payment_methods').select('*').eq('is_active', true)
      .then(({ data }) => {
        const m = (data as PaymentMethod[]) ?? []
        setMethods(m)
        if (m.length > 0) setMethodId(m[0].id)
      })
  }, [])

  const placeOrder = async (): Promise<boolean> => {
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
      return false
    }
    clear()
    navigate(`/pay/${data}`)
    return true
  }

  const confirmPlaceOrder = async () => {
    await placeOrder()
    setConfirmingOrder(false)
  }

  const selectedMethod = methods.find((m) => m.id === methodId) ?? null

  if (lines.length === 0) {
    return (
      <div className="max-w-md mx-auto min-h-dvh flex flex-col items-center justify-center gap-3 px-6 text-center app-frame">
        <ShoppingBasket className="size-14 text-brand-600" strokeWidth={2.5} aria-hidden="true" />
        <p className="text-ink-700 font-medium">Your cart is empty</p>
        <p className="text-ink-500 text-sm -mt-2">Add something from the shelf to get started.</p>
        <Link to="/store" className="text-brand-700 font-semibold mt-2 rounded-md">← Back to store</Link>
      </div>
    )
  }

  return (
    <div className="max-w-md mx-auto min-h-dvh px-4 py-4 space-y-6 app-frame">
      <header className="flex items-center gap-3">
        <Link to="/store" className="text-ink-500 text-lg leading-none rounded-md" aria-label="Back to store">←</Link>
        <h1 className="font-display text-xl font-bold">Your cart</h1>
      </header>

      <div className="space-y-3">
        {lines.map(({ item, qty }) => (
          <div key={item.id} className="rounded-lg bg-surface-raised p-3 shadow-card flex items-center gap-3">
            <div className="size-14 rounded-md bg-brand-50 flex items-center justify-center overflow-hidden shrink-0">
              {item.image_url
                ? <img src={item.image_url} alt="" className="w-full h-full object-cover" />
                : <ShoppingBasket className="size-6 text-brand-600/40" strokeWidth={2.5} aria-hidden="true" />}
            </div>
            <div className="grow min-w-0">
              <p className="font-medium text-sm truncate">{item.name}</p>
              <p className="text-brand-700 font-bold text-sm tabular-nums">{formatPeso(item.price)}</p>
            </div>
            <div className="flex items-center gap-1.5">
              <Stepper onClick={() => setLineQty(item.id, qty - 1)} label={`Decrease ${item.name} quantity`}>−</Stepper>
              <span className="w-6 text-center font-medium tabular-nums">{qty}</span>
              <Stepper onClick={() => setLineQty(item.id, qty + 1)} label={`Increase ${item.name} quantity`}>+</Stepper>
            </div>
            <button
              onClick={() => setPendingRemove({ item, qty })}
              aria-label={`Remove ${item.name} from cart`}
              className="size-8 shrink-0 rounded-full text-ink-500 hover:text-red-600 active:scale-90 transition flex items-center justify-center ml-0.5"
            >
              <Trash2 className="size-4" strokeWidth={2.5} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>

      <section className="space-y-2">
        <h2 className="font-semibold text-sm text-ink-700">Pay with</h2>
        {methods.length === 0 && (
          <p className="text-sm text-ink-500">No payment methods set up yet — ask your admin.</p>
        )}
        {methods.map((m) => {
          const selected = methodId === m.id
          const detail = methodDetail(m)
          return (
            <button
              key={m.id}
              onClick={() => setMethodId(m.id)}
              className={`w-full rounded-md p-3 text-left flex items-center gap-3 transition ${
                selected ? 'bg-ink-900 text-white' : 'bg-surface-raised shadow-card'
              }`}
            >
              {m.type === 'ewallet' && <Smartphone className="size-5" strokeWidth={2.5} aria-hidden="true" />}
              {m.type === 'bank' && <Landmark className="size-5" strokeWidth={2.5} aria-hidden="true" />}
              {m.type === 'cash' && <Banknote className="size-5" strokeWidth={2.5} aria-hidden="true" />}
              {m.type !== 'ewallet' && m.type !== 'bank' && m.type !== 'cash' && (
                <Landmark className="size-5" strokeWidth={2.5} aria-hidden="true" />
              )}
              <span className="flex flex-col min-w-0">
                <span className="font-medium truncate">{m.label}</span>
                {detail && (
                  <span className={`text-xs truncate ${selected ? 'text-white/70' : 'text-ink-500'}`}>
                    {detail}
                  </span>
                )}
              </span>
            </button>
          )
        })}
      </section>

      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}

      <button
        disabled={placing || !methodId}
        onClick={() => setConfirmingOrder(true)}
        className="w-full rounded-lg bg-brand-700 text-white py-4 font-bold text-lg disabled:bg-ink-400/40 disabled:text-ink-500 active:scale-[0.98] transition"
      >
        {placing ? 'Placing order…' : `Pay ${formatPeso(total)}`}
      </button>

      <ConfirmDialog
        open={pendingRemove !== null}
        destructive
        title="Remove item?"
        message={<>Remove <b>{pendingRemove?.item.name}</b> from your cart?</>}
        confirmLabel="Remove"
        onConfirm={() => {
          if (pendingRemove) setLineQty(pendingRemove.item.id, 0)
          setPendingRemove(null)
        }}
        onCancel={() => setPendingRemove(null)}
      />

      <ConfirmDialog
        open={confirmingOrder}
        title="Place this order?"
        message={
          <>{count} item{count === 1 ? '' : 's'} · <b>{formatPeso(total)}</b>{selectedMethod ? <> via {selectedMethod.label}</> : null}</>
        }
        confirmLabel="Place order"
        cancelLabel="Keep shopping"
        busy={placing}
        busyLabel="Placing order…"
        onConfirm={confirmPlaceOrder}
        onCancel={() => setConfirmingOrder(false)}
      />
    </div>
  )
}

function Stepper({ onClick, label, children }: { onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className="size-8 rounded-full bg-ink-900/5 font-bold active:scale-90 transition"
    >
      {children}
    </button>
  )
}
