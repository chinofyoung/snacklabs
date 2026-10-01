import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Banknote, Landmark, Smartphone, Wallet as WalletIcon } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { formatPeso } from '../lib/money'
import { compressImage } from '../lib/image'
import { TOPUP_PRESETS, mergeHistory, parseTopupAmount, rowSign, type HistoryRow } from '../lib/wallet'
import { useAuth } from '../context/AuthContext'
import type { PaymentMethod, TopupRequest, WalletEntry } from '../types'

type Phase = 'idle' | 'amount' | 'method' | 'uploading'

const PROOF_MAX_BYTES = 5 * 1024 * 1024

const inputCls = 'w-full rounded-md bg-surface border border-line px-3 py-2.5 text-sm outline-none focus-visible:outline-2 focus-visible:outline-brand-700'
const primaryBtnCls = 'w-full rounded-lg bg-brand-700 text-white py-4 font-bold disabled:bg-ink-400/40 disabled:text-ink-500 active:scale-[0.98] transition'
const secondaryBtnCls = 'rounded-lg bg-ink-900/5 text-ink-700 px-5 py-4 font-semibold disabled:opacity-50 active:scale-[0.98] transition'

// PostgREST and storage errors are not always `Error` instances, so read
// `.message` structurally rather than falling straight through to the fallback.
function errorMessage(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) return e.message
  const message = (e as { message?: unknown } | null)?.message
  return typeof message === 'string' && message ? message : fallback
}

export default function Wallet() {
  const { session } = useAuth()
  const userId = session?.user.id ?? null

  const [balance, setBalance] = useState<number | null>(null)
  const [entries, setEntries] = useState<WalletEntry[]>([])
  const [requests, setRequests] = useState<TopupRequest[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState(false)
  // True only while the most recent topup_requests read succeeded. Without it a
  // failed read looks like "no pending request" and would enable Top up.
  const [requestsKnown, setRequestsKnown] = useState(false)

  const [phase, setPhase] = useState<Phase>('idle')
  const [amountInput, setAmountInput] = useState('')
  const [methods, setMethods] = useState<PaymentMethod[] | null>(null)
  const [methodId, setMethodId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // The wallets/wallet_entries select policies let an ADMIN's session read every
  // row in the table (supabase/migrations/20261001000000_wallet_schema.sql), so
  // this page must filter to the signed-in user explicitly rather than rely on
  // RLS — otherwise an admin's own Top up tab would show everyone's money. Same
  // trap src/pages/Orders.tsx documents for orders.
  const load = useCallback(async (isCurrent: () => boolean = () => true) => {
    if (!userId) return
    const [wallet, ledger, topups] = await Promise.all([
      supabase.from('wallets').select('balance').eq('user_id', userId).maybeSingle(),
      supabase.from('wallet_entries').select('*').eq('user_id', userId)
        .order('created_at', { ascending: false }),
      supabase.from('topup_requests').select('*').eq('user_id', userId)
        .order('created_at', { ascending: false }),
    ])
    if (!isCurrent()) return
    // A failed read must not masquerade as an empty wallet: leave the previous
    // value in place and flag it, rather than showing a false ₱0.00. "No row"
    // counts as failed too. A read RLS filters to nothing is a 200 with
    // `error: null` and `data: null`, and every user has a wallets row (migration
    // backfill + handle_new_user), so an absent one is not a real zero.
    const walletRow = wallet.error ? null : wallet.data
    if (walletRow) setBalance(Number(walletRow.balance))
    if (!ledger.error) setEntries((ledger.data as WalletEntry[]) ?? [])
    if (!topups.error) setRequests((topups.data as TopupRequest[]) ?? [])
    setRequestsKnown(!topups.error)
    setLoadError(Boolean(!walletRow || ledger.error || topups.error))
    setLoaded(true)
  }, [userId])

  useEffect(() => {
    let cancelled = false
    void load(() => !cancelled)
    return () => { cancelled = true }
  }, [load])

  const loadMethods = async () => {
    const { data, error: methodsErr } = await supabase
      .from('payment_methods').select('*')
      .eq('is_active', true).neq('type', 'wallet')
      .order('created_at')
    if (methodsErr) {
      setMethods([])
      setError(errorMessage(methodsErr, 'Could not load payment methods — try again.'))
      return
    }
    const rows = (data as PaymentMethod[]) ?? []
    setMethods(rows)
    setMethodId((current) => (rows.some((m) => m.id === current) ? current : rows[0]?.id ?? null))
  }

  const history = useMemo(() => mergeHistory(entries, requests), [entries, requests])
  const hasPending = requests.some((r) => r.status === 'pending')
  // Don't claim "awaiting approval" unless the requests read actually succeeded.
  const topUpLabel = !loaded ? 'Top up'
    : !requestsKnown ? 'Top up unavailable'
    : hasPending ? 'Top-up awaiting approval'
    : 'Top up'
  const parsedAmount = parseTopupAmount(amountInput)
  const method = methods?.find((m) => m.id === methodId) ?? null
  const isCash = method?.type === 'cash'

  const startTopup = () => {
    setError(null)
    setPhase('amount')
  }

  const cancelTopup = () => {
    setError(null)
    setAmountInput('')
    setPhase('idle')
  }

  const backToAmount = () => {
    setError(null)
    setPhase('amount')
  }

  const submitAmount = (e: React.FormEvent) => {
    e.preventDefault()
    const parsed = parseTopupAmount(amountInput)
    if (!parsed.ok) {
      setError(parsed.error)
      return
    }
    setError(null)
    setPhase('method')
    void loadMethods()
  }

  // load() resolves rather than rejects on a failed read, so a rejection means
  // something unexpected threw; what we hold is then unknown, not merely stale.
  const reload = () => {
    load().catch(() => {
      setRequestsKnown(false)
      setLoadError(true)
    })
  }

  const handleFile = async (file: File) => {
    const parsed = parseTopupAmount(amountInput)
    if (!parsed.ok || !userId || !methodId) {
      setError('Pick an amount and a payment method first.')
      return
    }
    setError(null)
    setPhase('uploading')
    try {
      const blob = await compressImage(file)
      if (blob.size > PROOF_MAX_BYTES) throw new Error('Image too large even after compression')
      // The proof goes up BEFORE the request is created: topup_requests.proof_path
      // is not null, so a request row can never exist without its proof.
      const path = `${userId}/${crypto.randomUUID()}.jpg`
      const { error: upErr } = await supabase.storage
        .from('topup-proofs').upload(path, blob, { contentType: 'image/jpeg' })
      if (upErr) throw upErr
      const { error: rpcErr } = await supabase.rpc('request_topup', {
        p_amount: parsed.value, p_payment_method_id: methodId, p_proof_path: path,
      })
      if (rpcErr) throw rpcErr
    } catch (e) {
      setPhase('method')
      setError(errorMessage(e, 'Something went wrong — try again.'))
      // A network error can land after the server has committed, so the error
      // above doesn't prove no request exists. Resync rather than trust it.
      reload()
      return
    }
    // The request landed, so what we hold about pending status is now stale:
    // mark it unknown (keeps Top up disabled) until the refresh confirms it.
    setRequestsKnown(false)
    try {
      // Refresh before leaving the flow so the pending request is already in
      // state when the idle view returns.
      await load()
    } finally {
      // Always leave the flow, even if the refresh threw, so the page can't be
      // stranded in 'uploading' with a dead button.
      setAmountInput('')
      setMethodId(null)
      setPhase('idle')
    }
  }

  return (
    <div className="max-w-md mx-auto px-4 py-4 space-y-5 pb-28 app-frame">
      <header>
        <h1 className="font-display text-xl font-bold">Wallet</h1>
      </header>

      <div className="rounded-lg bg-surface-raised p-6 shadow-card text-center space-y-2">
        <p className="text-ink-500 text-sm">Wallet balance</p>
        <p className="text-4xl font-black text-brand-700 tabular-nums">
          {balance === null ? '—' : formatPeso(balance)}
        </p>
      </div>

      {loadError && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-600 flex items-center justify-between gap-3" role="alert">
          <p>Could not load your wallet — check your connection.</p>
          <button onClick={reload} className="shrink-0 rounded-full bg-white px-3 py-1.5 text-xs font-medium text-red-600 shadow-card">
            Retry
          </button>
        </div>
      )}

      {phase === 'idle' && (
        <button
          disabled={!requestsKnown || hasPending}
          onClick={startTopup}
          className={primaryBtnCls}
        >
          {topUpLabel}
        </button>
      )}

      {phase === 'amount' && (
        <form onSubmit={submitAmount} noValidate className="rounded-lg bg-surface-raised p-4 shadow-card space-y-4">
          <p className="font-semibold text-sm text-ink-700">How much do you want to add?</p>
          <div className="flex gap-2">
            {TOPUP_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                aria-pressed={amountInput.trim() === String(preset)}
                onClick={() => { setAmountInput(String(preset)); setError(null) }}
                className={`flex-1 rounded-full py-2.5 text-sm font-medium tabular-nums transition ${
                  amountInput.trim() === String(preset) ? 'bg-ink-900 text-white' : 'bg-ink-900/5 text-ink-700'
                }`}
              >
                {formatPeso(preset)}
              </button>
            ))}
          </div>
          <label className="block space-y-1">
            <span className="block text-xs font-medium text-ink-500">Or enter an amount</span>
            <input
              inputMode="decimal"
              autoComplete="off"
              placeholder="250"
              value={amountInput}
              onChange={(e) => { setAmountInput(e.target.value); setError(null) }}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'topup-error' : undefined}
              className={inputCls}
            />
          </label>
          {error && <p id="topup-error" className="text-sm text-red-600" role="alert">{error}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={cancelTopup} className={secondaryBtnCls}>Cancel</button>
            <button type="submit" className={`${primaryBtnCls} grow`}>Continue</button>
          </div>
        </form>
      )}

      {(phase === 'method' || phase === 'uploading') && (
        <div className="space-y-4">
          <div className="rounded-lg bg-surface-raised p-6 shadow-card text-center space-y-4">
            <p className="text-ink-500 text-sm">Amount to send</p>
            <p className="text-4xl font-black text-brand-700 tabular-nums">
              {parsedAmount.ok ? formatPeso(parsedAmount.value) : '—'}
            </p>
            {methods === null && <p className="text-sm text-ink-500">Loading payment methods…</p>}
            {methods !== null && methods.length === 0 && !error && (
              <p className="text-sm text-ink-500">No payment methods set up yet — ask your admin.</p>
            )}
            {method && isCash && (
              <>
                <Banknote className="size-16 mx-auto text-brand-600" strokeWidth={2} aria-hidden="true" />
                <div>
                  <p className="font-semibold">{method.label}</p>
                  <p className="text-sm text-ink-500">
                    {parsedAmount.ok && <>Top up {formatPeso(parsedAmount.value)} in cash — </>}
                    hand it to {method.account_name} or drop it in the box,
                    then upload a photo of the cash you&apos;re adding.
                  </p>
                </div>
              </>
            )}
            {method && !isCash && (
              <>
                {method.qr_image_url && (
                  <img src={method.qr_image_url} alt={`${method.label} QR code`} className="mx-auto w-64 rounded-md" />
                )}
                <div>
                  <p className="font-semibold">{method.label}</p>
                  <p className="text-sm text-ink-500">{method.account_name}</p>
                  {!method.qr_image_url && method.account_number && (
                    <p className="text-sm text-ink-500 tabular-nums">{method.account_number}</p>
                  )}
                </div>
              </>
            )}
          </div>

          {methods !== null && methods.length > 1 && (
            <section className="space-y-2">
              <h2 className="font-semibold text-sm text-ink-700">Pay with</h2>
              {methods.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={m.id === methodId}
                  disabled={phase === 'uploading'}
                  onClick={() => setMethodId(m.id)}
                  className={`w-full rounded-md p-3 text-left flex items-center gap-3 transition disabled:opacity-50 ${
                    m.id === methodId ? 'bg-ink-900 text-white' : 'bg-surface-raised shadow-card'
                  }`}
                >
                  {m.type === 'ewallet' && <Smartphone className="size-5" strokeWidth={2.5} aria-hidden="true" />}
                  {m.type === 'cash' && <Banknote className="size-5" strokeWidth={2.5} aria-hidden="true" />}
                  {m.type !== 'ewallet' && m.type !== 'cash' && (
                    <Landmark className="size-5" strokeWidth={2.5} aria-hidden="true" />
                  )}
                  <span className="font-medium truncate">{m.label}</span>
                </button>
              ))}
            </section>
          )}

          {method && (
            <>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  // Clear the input so re-picking the same file after a failure still fires onChange.
                  e.target.value = ''
                  if (file) void handleFile(file)
                }}
              />
              <button
                disabled={phase === 'uploading'}
                onClick={() => fileRef.current?.click()}
                className={primaryBtnCls}
              >
                {phase === 'uploading'
                  ? 'Uploading…'
                  : isCash ? "I've paid — upload photo proof" : "I've paid — upload screenshot"}
              </button>
            </>
          )}
          {error && <p className="text-sm text-red-600 text-center" role="alert">{error}</p>}
          <button
            type="button"
            disabled={phase === 'uploading'}
            onClick={backToAmount}
            className="w-full text-center text-sm font-semibold text-ink-500 py-2 rounded-md disabled:opacity-50"
          >
            ← Change amount
          </button>
        </div>
      )}

      {phase === 'idle' && (
        <section className="space-y-3">
          <h2 className="font-semibold text-sm text-ink-700">History</h2>
          {!loaded ? (
            <p className="text-center text-ink-500 py-8">Loading…</p>
          ) : history.length === 0 ? (
            // A failed read already shows its own alert above; claiming "no activity" there would be false.
            !loadError && (
              <div className="text-center py-10 space-y-2">
                <WalletIcon className="size-12 mx-auto text-ink-500" strokeWidth={2.5} aria-hidden="true" />
                <p className="text-ink-700 font-medium">No wallet activity yet</p>
                <p className="text-ink-500 text-sm">Top-ups and wallet purchases will show up here.</p>
              </div>
            )
          ) : (
            <ul role="list" className="space-y-2">
              {history.map((row) => <HistoryItem key={`${row.kind}-${row.id}`} row={row} />)}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}

function HistoryItem({ row }: { row: HistoryRow }) {
  const rejected = row.kind === 'rejected'
  const pending = row.kind === 'pending'
  const labelTone = rejected ? 'text-ink-500' : pending ? 'text-amber-700' : 'text-ink-900'
  const amountTone = rejected
    ? 'text-ink-500 line-through'
    : pending ? 'text-amber-700' : row.amount < 0 ? 'text-ink-900' : 'text-green-700'

  return (
    <li className="rounded-lg bg-surface-raised p-4 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <p className={`font-medium text-sm ${labelTone}`}>{row.label}</p>
          <p className="text-xs text-ink-500">{new Date(row.created_at).toLocaleString()}</p>
        </div>
        <span className={`font-bold tabular-nums shrink-0 ${amountTone}`}>
          {rowSign(row)}{formatPeso(Math.abs(row.amount))}
        </span>
      </div>
      {rejected && row.detail && <p className="mt-1 text-xs text-ink-500">{row.detail}</p>}
    </li>
  )
}
