import { useCallback, useEffect, useState, useRef } from 'react'
import { Link, useParams, useNavigate } from 'react-router'
import { Banknote, CircleCheck, Clock, ScanSearch, Wallet as WalletIcon } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { formatPeso } from '../lib/money'
import { compressImage } from '../lib/image'
import { canAfford, describePayError, isInsufficientBalance } from '../lib/wallet'
import type { Order, PaymentMethod } from '../types'

export default function Pay() {
  const { orderId } = useParams()
  const navigate = useNavigate()
  const [order, setOrder] = useState<Order | null>(null)
  const [method, setMethod] = useState<PaymentMethod | null>(null)
  const [countdown, setCountdown] = useState(10)
  // null means "not known": still loading, or the read failed or came back with
  // no row (balanceFailed). None of those may be shown as an empty wallet.
  const [balance, setBalance] = useState<number | null>(null)
  const [balanceFailed, setBalanceFailed] = useState(false)

  useEffect(() => {
    if (!orderId) return
    supabase.from('orders').select('*').eq('id', orderId).single()
      .then(async ({ data }) => {
        const o = data as Order | null
        if (o?.payment_method_id) {
          const { data: pm } = await supabase
            .from('payment_methods').select('*').eq('id', o.payment_method_id).single()
          setMethod(pm as PaymentMethod)
        }
        // The order is only published once its method is known (React batches
        // both updates into one render). Otherwise a wallet order would flash
        // the receipt-upload control until the method arrived, and a tap in
        // that window would send a wallet order to receipt verification.
        setOrder(o)
      })
  }, [orderId])

  const isWalletOrder = method?.type === 'wallet'
  const ownerId = order?.user_id ?? null
  // Filtered to the order's owner explicitly: the wallets select policy lets an
  // admin's session read every row (supabase/migrations/20261001000000_wallet_schema.sql),
  // so an unfiltered read could show someone else's balance.
  const loadBalance = useCallback(async (isCurrent: () => boolean = () => true) => {
    if (!ownerId) return
    try {
      const { data, error } = await supabase
        .from('wallets').select('balance').eq('user_id', ownerId).maybeSingle()
      if (!isCurrent()) return
      // `!data` is the RLS-filtered case: a 200 with `error: null` and no row.
      // It is unknown, exactly like an error, never a balance of zero.
      if (error || !data) {
        // A failed read leaves the balance unknown, not stale: after a refusal
        // the old figure is exactly the one the server just contradicted.
        setBalance(null)
        setBalanceFailed(true)
      } else {
        setBalance(Number(data.balance))
        setBalanceFailed(false)
      }
    } catch {
      if (isCurrent()) {
        setBalance(null)
        setBalanceFailed(true)
      }
    }
  }, [ownerId])

  useEffect(() => {
    if (!isWalletOrder) return
    let cancelled = false
    void loadBalance(() => !cancelled)
    return () => { cancelled = true }
  }, [isWalletOrder, loadBalance])

  // The server just refused on balance, so the figure on the card is wrong.
  // Blank it (rather than keep showing "₱10.00 available") until the re-read lands.
  const refreshBalance = () => {
    setBalance(null)
    setBalanceFailed(false)
    void loadBalance()
  }

  useEffect(() => {
    if (order?.status !== 'paid') return
    if (countdown <= 0) {
      navigate('/store')
      return
    }
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [order?.status, countdown, navigate])

  if (!order) return <div className="max-w-md mx-auto min-h-dvh flex items-center justify-center text-ink-500 app-frame">Loading…</div>

  return (
    <div className="max-w-md mx-auto min-h-dvh px-4 py-4 space-y-5 app-frame">
      <header className="flex items-center gap-3">
        <Link to="/store" className="text-ink-500 text-lg leading-none rounded-md" aria-label="Back to store">←</Link>
        <h1 className="font-display text-xl font-bold">{method?.type === 'wallet' ? 'Pay' : 'Scan & pay'}</h1>
      </header>

      <div className="rounded-lg bg-surface-raised p-6 shadow-card text-center space-y-4">
        <p className="text-ink-500 text-sm">Amount due</p>
        <p className="text-4xl font-black text-brand-700 tabular-nums">{formatPeso(order.total)}</p>
        {method && method.type === 'cash' && (
          <>
            <Banknote className="size-16 mx-auto text-brand-600" strokeWidth={2} aria-hidden="true" />
            <div>
              <p className="font-semibold">{method.label}</p>
              <p className="text-sm text-ink-500">
                Pay {formatPeso(order.total)} in cash — hand it to {method.account_name} or drop it in the box,
                then upload a photo of the cash you're paying.
              </p>
            </div>
          </>
        )}
        {method && method.type === 'wallet' && (
          <>
            <WalletIcon className="size-16 mx-auto text-brand-600" strokeWidth={2} aria-hidden="true" />
            <div>
              <p className="font-semibold">
                {order.status === 'paid' ? 'Paid from your balance' : 'Pay from your balance'}
              </p>
              {order.status === 'awaiting_payment' && (
                <p className="text-sm text-ink-500">
                  {walletSummary(balance, balanceFailed, order.total)}
                </p>
              )}
            </div>
          </>
        )}
        {method && method.type !== 'cash' && method.type !== 'wallet' && (
          <>
            <img src={method.qr_image_url ?? undefined} alt={`${method.label} QR code`} className="mx-auto w-64 rounded-md" />
            <div>
              <p className="font-semibold">{method.label}</p>
              <p className="text-sm text-ink-500">{method.account_name}</p>
            </div>
          </>
        )}
      </div>

      <PaymentStatus order={order} method={method} onUpdated={setOrder} onInsufficient={refreshBalance} />

      {['paid', 'needs_review', 'cancelled'].includes(order.status) && (
        <Link
          to="/store"
          className="block w-full text-center rounded-2xl bg-ink-900 text-white py-4 font-bold active:scale-[0.98] transition"
        >
          Back to store
        </Link>
      )}

      {order.status === 'paid' && (
        <p className="text-center text-sm text-ink-500">Returning to store in {countdown}…</p>
      )}
    </div>
  )
}

type Phase = 'idle' | 'uploading' | 'verifying' | 'paying' | 'done'

// What is left after the purchase, in whole centavos so float noise can never
// surface as "-P0.00" when the balance covers the total exactly.
function remainingAfter(balance: number, total: number): number {
  return (Math.round(balance * 100) - Math.round(total * 100)) / 100
}

// Display only: the Pay button stays enabled whatever this says, because the
// server decides whether the balance covers the order (it may have moved since
// this page loaded). canAfford compares in centavos, as the database does.
function walletSummary(balance: number | null, failed: boolean, total: number): string {
  if (balance === null) {
    return failed
      ? "Couldn't load your balance — we'll check it when you pay."
      : 'Checking your balance…'
  }
  if (!canAfford(balance, total)) {
    return `${formatPeso(balance)} available — not enough for this order`
  }
  return `${formatPeso(balance)} available · ${formatPeso(remainingAfter(balance, total))} left after`
}

async function edgeErrorMessage(err: unknown, fallback: string): Promise<string> {
  const ctx = (err as { context?: Response } | null)?.context
  if (ctx && typeof ctx.json === 'function') {
    try {
      const body = await ctx.clone().json()
      if (body?.error) return String(body.error)
    } catch { /* not JSON */ }
  }
  return err instanceof Error ? err.message : fallback
}

interface PaymentStatusProps {
  order: Order
  method: PaymentMethod | null
  onUpdated: (o: Order) => void
  // The server refused on balance: the parent's cached balance is now known wrong.
  onInsufficient: () => void
}

function PaymentStatus({ order, method, onUpdated, onInsufficient }: PaymentStatusProps) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [errorLink, setErrorLink] = useState<'topup' | 'orders' | null>(null)
  const isCash = method?.type === 'cash'
  const isWallet = method?.type === 'wallet'

  const handleFile = async (file: File) => {
    setError(null)
    setPhase('uploading')
    try {
      const blob = await compressImage(file)
      if (blob.size > 5 * 1024 * 1024) throw new Error('Image too large even after compression')
      const path = `${order.user_id}/${order.id}.jpg`
      const { error: upErr } = await supabase.storage
        .from('receipts')
        .upload(path, blob, { contentType: 'image/jpeg', upsert: true })
      if (upErr) throw upErr

      setPhase('verifying')
      const { data, error: fnErr } = await supabase.functions.invoke('verify-payment', {
        body: { order_id: order.id, receipt_path: path },
      })
      if (fnErr) throw new Error(await edgeErrorMessage(fnErr, 'Verification failed'))

      const { data: fresh } = await supabase.from('orders').select('*').eq('id', order.id).single()
      if (fresh) onUpdated(fresh as Order)
      setPhase('done')
      void data
    } catch (e) {
      setPhase('idle')
      setError(e instanceof Error ? e.message : 'Something went wrong — try again.')
    }
  }

  const readOrder = async (): Promise<Order | null> => {
    const { data } = await supabase.from('orders').select('*').eq('id', order.id).single()
    return (data as Order | null) ?? null
  }

  // True when the order has moved off awaiting_payment, in which case the
  // existing paid / cancelled UI takes over from the fresh row.
  const resyncOrder = async (): Promise<boolean> => {
    const fresh = await readOrder()
    if (!fresh || fresh.status === 'awaiting_payment') return false
    onUpdated(fresh)
    return true
  }

  // No receipt, no verification: the debit is a single RPC, and its success is
  // read back from the order so the existing paid state takes over.
  const payFromWallet = async () => {
    setError(null)
    setErrorLink(null)
    setPhase('paying')
    const { error: rpcErr } = await supabase.rpc('pay_order_with_wallet', { p_order_id: order.id })
    if (rpcErr) {
      let moved = false
      if (isInsufficientBalance(rpcErr.message)) {
        // The server is authoritative on balance: it may have moved since this
        // page rendered, so its refusal wins and the cached figure is refreshed.
        onInsufficient()
      } else {
        // Any other error does not prove nothing happened. postgrest-js returns
        // a dropped response as an error even when the server already
        // committed, and the order may equally have been paid in another tab or
        // cancelled by an admin. Resync first; only an order that has not moved
        // gets the error.
        moved = await resyncOrder()
      }
      setPhase('idle')
      if (moved) return
      const view = describePayError(rpcErr.message)
      setError(view.text)
      setErrorLink(view.link)
      return
    }
    const fresh = await readOrder()
    if (fresh) {
      onUpdated(fresh)
    } else {
      setError('Your payment went through, but we could not refresh this page.')
      setErrorLink('orders')
    }
    setPhase('done')
  }

  if (order.status === 'paid') {
    return (
      <div className="rounded-lg bg-green-50 text-green-800 p-5 text-center space-y-1">
        <CircleCheck className="size-8 mx-auto" strokeWidth={2.5} aria-hidden="true" />
        <p className="font-bold">Payment verified — enjoy!</p>
      </div>
    )
  }
  if (order.status === 'needs_review') {
    return (
      <div className="rounded-lg bg-amber-50 text-amber-800 p-5 text-center space-y-1">
        <Clock className="size-8 mx-auto" strokeWidth={2.5} aria-hidden="true" />
        <p className="font-bold">Sent to admin for review</p>
        {order.ai_verdict?.reason && <p className="text-sm">{order.ai_verdict.reason}</p>}
      </div>
    )
  }
  if (order.status === 'cancelled') {
    return <p className="text-center text-ink-500">This order was cancelled.</p>
  }
  if (order.status === 'verifying') {
    return (
      <div className="rounded-lg bg-blue-50 text-blue-800 p-5 text-center space-y-1">
        <ScanSearch className="size-8 mx-auto" strokeWidth={2.5} aria-hidden="true" />
        <p className="font-bold">Verifying your payment…</p>
        <p className="text-sm">This usually takes a few seconds. Check My Orders for the result.</p>
      </div>
    )
  }

  if (isWallet) {
    return (
      <div className="space-y-2">
        <button
          disabled={phase !== 'idle'}
          onClick={() => void payFromWallet()}
          className="w-full rounded-lg bg-brand-700 text-white py-4 font-bold disabled:bg-ink-400/40 disabled:text-ink-500 active:scale-[0.98] transition"
        >
          {phase === 'idle' && `Pay ${formatPeso(order.total)} from balance`}
          {phase === 'paying' && 'Paying…'}
          {phase === 'done' && 'Done'}
        </button>
        {error && <p className="text-sm text-red-600 text-center" role="alert">{error}</p>}
        {errorLink && (
          <Link
            to={errorLink === 'topup' ? '/wallet' : '/orders'}
            className="block text-center text-sm font-semibold text-brand-700 py-2 rounded-md"
          >
            {errorLink === 'topup' ? 'Top up' : 'My Orders'}
          </Link>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
      />
      <button
        disabled={phase !== 'idle'}
        onClick={() => fileRef.current?.click()}
        className="w-full rounded-lg bg-brand-700 text-white py-4 font-bold disabled:bg-ink-400/40 disabled:text-ink-500 active:scale-[0.98] transition"
      >
        {phase === 'idle' && (isCash ? "I've paid — upload photo proof" : "I've paid — upload screenshot")}
        {phase === 'uploading' && 'Uploading…'}
        {phase === 'verifying' && 'Verifying with AI…'}
        {phase === 'done' && 'Done'}
      </button>
      {error && <p className="text-sm text-red-600 text-center" role="alert">{error}</p>}
    </div>
  )
}
