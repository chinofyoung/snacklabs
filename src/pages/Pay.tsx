import { useEffect, useState, useRef } from 'react'
import { Link, useParams, useNavigate } from 'react-router'
import { Banknote, CircleCheck, Clock, ScanSearch } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { formatPeso } from '../lib/money'
import { compressImage } from '../lib/image'
import type { Order, PaymentMethod } from '../types'

export default function Pay() {
  const { orderId } = useParams()
  const navigate = useNavigate()
  const [order, setOrder] = useState<Order | null>(null)
  const [method, setMethod] = useState<PaymentMethod | null>(null)
  const [countdown, setCountdown] = useState(10)

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

  useEffect(() => {
    if (order?.status !== 'paid') return
    if (countdown <= 0) {
      navigate('/')
      return
    }
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [order?.status, countdown, navigate])

  if (!order) return <div className="max-w-md mx-auto min-h-dvh flex items-center justify-center text-ink-500 app-frame">Loading…</div>

  return (
    <div className="max-w-md mx-auto min-h-dvh px-4 py-4 space-y-5 app-frame">
      <header className="flex items-center gap-3">
        <Link to="/" className="text-ink-500 text-lg leading-none rounded-md" aria-label="Back to store">←</Link>
        <h1 className="font-display text-xl font-bold">Scan & pay</h1>
      </header>

      <div className="rounded-lg bg-surface-raised p-6 shadow-card text-center space-y-4">
        <p className="text-ink-500 text-sm">Amount due</p>
        <p className="text-4xl font-black text-brand-600 tabular-nums">{formatPeso(order.total)}</p>
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
        {method && method.type !== 'cash' && (
          <>
            <img src={method.qr_image_url ?? undefined} alt={`${method.label} QR code`} className="mx-auto w-64 rounded-md" />
            <div>
              <p className="font-semibold">{method.label}</p>
              <p className="text-sm text-ink-500">{method.account_name}</p>
            </div>
          </>
        )}
      </div>

      <PaymentStatus order={order} onUpdated={setOrder} />

      {['paid', 'needs_review', 'cancelled'].includes(order.status) && (
        <Link
          to="/"
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

type Phase = 'idle' | 'uploading' | 'verifying' | 'done'

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

function PaymentStatus({ order, onUpdated }: { order: Order; onUpdated: (o: Order) => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)

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
        className="w-full rounded-lg bg-brand-600 text-white py-4 font-bold disabled:bg-ink-400/40 disabled:text-ink-500 active:scale-[0.98] transition"
      >
        {phase === 'idle' && "I've paid — upload screenshot"}
        {phase === 'uploading' && 'Uploading…'}
        {phase === 'verifying' && 'Verifying with AI…'}
        {phase === 'done' && 'Done'}
      </button>
      {error && <p className="text-sm text-red-600 text-center" role="alert">{error}</p>}
    </div>
  )
}
