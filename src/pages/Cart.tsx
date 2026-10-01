import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Banknote, Landmark, ShoppingBasket, Smartphone, Trash2, Wallet as WalletIcon } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useCart } from '../context/CartContext'
import { formatPeso } from '../lib/money'
import { canAfford } from '../lib/wallet'
import ConfirmDialog from '../components/ConfirmDialog'
import type { CartLine, PaymentMethod } from '../types'

// `balance` is null until the wallets read settles (or if it failed), and then
// renders as a dash rather than a false P0.00.
function methodDetail(m: PaymentMethod, balance: number | null): string | null {
  if (m.type === 'wallet') return `Balance ${balance === null ? '—' : formatPeso(balance)}`
  const name = m.account_name.trim()
  const number = m.account_number.trim()
  if (name && number) return `${name} · ${number}`
  return name || number || null
}

export default function Cart() {
  const { lines, setLineQty, total, clear, count } = useCart()
  const { session } = useAuth()
  const userId = session?.user.id ?? null
  const [methods, setMethods] = useState<PaymentMethod[]>([])
  // Tells "loaded, and none configured" apart from "could not load": an empty
  // `methods` alone is both, and only the first is the admin's doing.
  const [methodsStatus, setMethodsStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  // The method the customer tapped. Never read directly: `selectedMethod` below
  // is what's actually in effect, because a tapped wallet can stop being usable.
  const [methodId, setMethodId] = useState<string | null>(null)
  // null means "not known": still loading, or the read failed or came back with
  // no row (balanceFailed). None of those may be shown as an empty wallet.
  const [balance, setBalance] = useState<number | null>(null)
  const [balanceFailed, setBalanceFailed] = useState(false)
  const [placing, setPlacing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingRemove, setPendingRemove] = useState<CartLine | null>(null)
  const [confirmingOrder, setConfirmingOrder] = useState(false)
  const navigate = useNavigate()

  const loadMethods = useCallback(() => {
    supabase.from('payment_methods').select('*').eq('is_active', true)
      .then(({ data, error: readErr }) => {
        if (readErr) {
          setMethodsStatus('failed')
          return
        }
        setMethods((data as PaymentMethod[]) ?? [])
        setMethodsStatus('ready')
      })
  }, [])

  useEffect(() => { loadMethods() }, [loadMethods])

  const retryMethods = () => {
    setMethodsStatus('loading')
    loadMethods()
  }

  // Filtered to the signed-in user explicitly: the wallets select policy lets an
  // admin's session read every row (supabase/migrations/20261001000000_wallet_schema.sql),
  // so relying on RLS would show an admin someone else's balance.
  useEffect(() => {
    if (!userId) return
    let cancelled = false
    const loadBalance = async () => {
      try {
        const { data, error: readErr } = await supabase
          .from('wallets').select('balance').eq('user_id', userId).maybeSingle()
        if (cancelled) return
        // No row is unknown, not zero. A read that RLS filters to nothing is a
        // 200 with `error: null` and `data: null`, so checking `readErr` alone
        // would turn it into "Not enough — top up" for a customer who has money.
        // Every user has a wallets row (migration backfill + handle_new_user), so
        // an absent one means this read is not telling us the truth.
        if (readErr || !data) setBalanceFailed(true)
        else setBalance(Number(data.balance))
      } catch {
        if (!cancelled) setBalanceFailed(true)
      }
    }
    void loadBalance()
    return () => { cancelled = true }
  }, [userId])

  // The wallet is only usable once its balance is known and covers the cart.
  // canAfford compares in centavos; never compare balance >= total here.
  const affordable = (m: PaymentMethod) =>
    m.type !== 'wallet' || (balance !== null && canAfford(balance, total))
  // Wallet first when it can pay, so it is the natural default. Array.sort is
  // stable, so every other method keeps the order it came back in.
  const orderedMethods = [...methods].sort((a, b) =>
    Number(b.type === 'wallet' && affordable(b)) - Number(a.type === 'wallet' && affordable(a)))
  const hasWallet = methods.some((m) => m.type === 'wallet')
  const balanceSettled = balance !== null || balanceFailed
  // Derived rather than set on load, so the effective method follows the cart:
  // a wallet that stops covering the total after a quantity change, or that
  // hasn't loaded its balance yet, never leaves the customer parked on it.
  // Auto-pick waits for the balance when there is a wallet to rank, so the
  // default can't flip from another method to the wallet a moment later.
  const selectedMethod =
    orderedMethods.find((m) => m.id === methodId && affordable(m))
    ?? (hasWallet && !balanceSettled ? undefined : orderedMethods.find(affordable))
    ?? null

  const placeOrder = async (): Promise<boolean> => {
    setPlacing(true)
    setError(null)
    const { data, error } = await supabase.rpc('create_order', {
      p_items: lines.map((l) => ({ item_id: l.item.id, qty: l.qty })),
      p_payment_method_id: selectedMethod?.id ?? null,
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
        {methodsStatus === 'loading' && (
          <p className="text-sm text-ink-500">Loading payment methods…</p>
        )}
        {methodsStatus === 'failed' && (
          <div className="rounded-md bg-red-50 p-3 text-sm text-red-600 flex items-center justify-between gap-3" role="alert">
            <p>Couldn&apos;t load payment methods.</p>
            <button onClick={retryMethods} className="shrink-0 rounded-full bg-white px-3 py-1.5 text-xs font-medium text-red-600 shadow-card">
              Retry
            </button>
          </div>
        )}
        {methodsStatus === 'ready' && methods.length === 0 && (
          <p className="text-sm text-ink-500">No payment methods set up yet — ask your admin.</p>
        )}
        {orderedMethods.map((m) => {
          const selected = selectedMethod?.id === m.id
          // Balance known but short. Unknown balance (loading, or the read
          // failed) is deliberately not this case: "not enough" would be a
          // claim we can't back, so that row is just disabled, below.
          const short = m.type === 'wallet' && balance !== null && !affordable(m)
          const detail = short ? 'Not enough — top up' : methodDetail(m, balance)
          // Only the icon and label dim on a short wallet. The hint is the
          // row's one call to action, so it stays at full strength in brand
          // colour, and the row itself is never faded: `opacity` on the link
          // would also fade its focus outline (src/index.css draws it on the
          // element) below the 3:1 non-text minimum.
          const dim = short ? 'opacity-60' : ''
          const hintCls = short
            ? 'text-brand-700 font-medium'
            : selected ? 'text-white/70' : 'text-ink-500'
          const content = (
            <>
              <MethodIcon type={m.type} className={dim} />
              <span className="flex flex-col min-w-0">
                <span className={`font-medium truncate ${dim}`}>{m.label}</span>
                {detail && <span className={`text-xs truncate ${hintCls}`}>{detail}</span>}
              </span>
            </>
          )

          // A link, not a disabled button: a disabled control swallows the tap,
          // and wrapping one in a link is invalid HTML. Not selectable, but it
          // is a live, focusable control that goes to the Top up tab, so it
          // deliberately carries no aria-disabled or tabindex=-1.
          if (short) {
            return (
              <Link key={m.id} to="/wallet" className={rowCls(false)}>
                {content}
              </Link>
            )
          }

          const unusable = !affordable(m)
          return (
            <button
              key={m.id}
              disabled={unusable}
              onClick={() => setMethodId(m.id)}
              className={`${rowCls(selected)} ${unusable ? 'opacity-60' : ''}`}
            >
              {content}
            </button>
          )
        })}
        {hasWallet && balanceFailed && (
          <p className="text-sm text-red-600" role="alert">
            Could not load your wallet balance — reload to pay from it.
          </p>
        )}
      </section>

      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}

      <button
        disabled={placing || !selectedMethod}
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

const rowCls = (selected: boolean) =>
  `w-full rounded-md p-3 text-left flex items-center gap-3 transition ${
    selected ? 'bg-ink-900 text-white' : 'bg-surface-raised shadow-card'
  }`

function MethodIcon({ type, className = '' }: { type: PaymentMethod['type']; className?: string }) {
  const cls = `size-5 ${className}`.trim()
  if (type === 'ewallet') return <Smartphone className={cls} strokeWidth={2.5} aria-hidden="true" />
  if (type === 'cash') return <Banknote className={cls} strokeWidth={2.5} aria-hidden="true" />
  if (type === 'wallet') return <WalletIcon className={cls} strokeWidth={2.5} aria-hidden="true" />
  return <Landmark className={cls} strokeWidth={2.5} aria-hidden="true" />
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
