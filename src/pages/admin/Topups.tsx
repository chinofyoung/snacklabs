import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Wallet as WalletIcon } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { formatPeso } from '../../lib/money'
import ConfirmDialog from '../../components/ConfirmDialog'
import { useAuth } from '../../context/AuthContext'
import type { TopupRequest } from '../../types'

interface TopupRow extends TopupRequest {
  profiles: { full_name: string; email: string } | null
  method: { label: string } | null
}

type Filter = 'pending' | 'all'

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'all', label: 'All' },
]

// A user can hold at most one pending request (unique index in the wallet
// schema), so the Pending view is naturally small. History is not, and every
// row costs a storage round-trip to sign its proof, so it is capped.
const ALL_LIMIT = 50
// Same lifetime AdminOrders gives a signed receipt URL.
const PROOF_URL_TTL_SECONDS = 300
const REASON_MAX_LENGTH = 200

const SELECT = '*, profiles:user_id (full_name, email), method:payment_method_id (label)'

const inputCls = 'w-full rounded-md bg-surface border border-line px-3 py-2.5 text-sm outline-none focus-visible:outline-2 focus-visible:outline-brand-700'

const relativeFormat = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

// Truncates rather than rounds so "90 minutes ago" reads as 1 hour, never 2.
function relativeTime(iso: string): string {
  const seconds = Math.trunc((new Date(iso).getTime() - Date.now()) / 1000)
  const abs = Math.abs(seconds)
  if (abs < 60) return 'just now'
  if (abs < 3600) return relativeFormat.format(Math.trunc(seconds / 60), 'minute')
  if (abs < 86400) return relativeFormat.format(Math.trunc(seconds / 3600), 'hour')
  if (abs < 86400 * 30) return relativeFormat.format(Math.trunc(seconds / 86400), 'day')
  return new Date(iso).toLocaleDateString()
}

function requesterName(row: TopupRow): string {
  return row.profiles?.full_name || row.profiles?.email || 'Unknown'
}

// RPC messages arrive with Postgres's own spacing (approve_topup raises
// 'top-up already approved ' with a trailing space).
function errorText(e: { message?: string } | null | undefined, fallback: string): string {
  return e?.message?.trim() || fallback
}

// approve_topup refuses an admin approving their own request. The UI never
// offers that action, so this only surfaces if the client and server disagree
// (a stale session, a hand-crafted call) - say it plainly rather than echo
// the raw exception.
const OWN_TOPUP_SERVER_MESSAGE = 'cannot approve your own top-up'
const OWN_TOPUP_MESSAGE = "You can't approve your own top-up."

function approveErrorText(e: { message?: string } | null | undefined): string {
  const message = errorText(e, 'Could not approve this top-up.')
  return message.includes(OWN_TOPUP_SERVER_MESSAGE) ? OWN_TOPUP_MESSAGE : message
}

// 'top-up already approved' -> 'Top-up already approved.'
function sentence(message: string): string {
  const trimmed = message.trim()
  return (trimmed.charAt(0).toUpperCase() + trimmed.slice(1)).replace(/[.!?]*$/, '.')
}

export default function Topups() {
  const { session } = useAuth()
  const myId = session?.user.id ?? null
  const [filter, setFilter] = useState<Filter>('pending')
  // Tagged with the filter it was fetched for, so flipping a chip never shows
  // the other view's rows under the wrong heading while the new fetch is out.
  const [loaded, setLoaded] = useState<{ filter: Filter; rows: TopupRow[] } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // id -> signed proof URL. undefined = still signing, null = could not be
  // loaded. Never a public URL: the topup-proofs bucket is private.
  const [proofUrls, setProofUrls] = useState<Record<string, string | null>>({})

  const [busy, setBusy] = useState(false)
  const [pendingApprove, setPendingApprove] = useState<TopupRow | null>(null)
  const [approveError, setApproveError] = useState<string | null>(null)
  const [rejectingId, setRejectingId] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [rejectError, setRejectError] = useState<string | null>(null)
  // Page-level explanation for an action the server refused. Lives outside the
  // dialog / reject form because those close when the row turns out to be dead.
  const [notice, setNotice] = useState<string | null>(null)

  const reasonId = useId()
  const reasonRef = useRef<HTMLTextAreaElement>(null)
  // Only the newest request may write state, so a slow response for a filter
  // the admin has already left cannot overwrite the current view or its error.
  const loadSeq = useRef(0)

  const signProofs = useCallback(async (rows: TopupRow[], seq: number) => {
    const signedByPath = new Map<string, string>()
    if (rows.length > 0) {
      // One round-trip for the whole list; each entry still carries its own
      // error, so one missing object does not blank the other thumbnails.
      try {
        const { data, error } = await supabase.storage
          .from('topup-proofs').createSignedUrls(rows.map((r) => r.proof_path), PROOF_URL_TTL_SECONDS)
        if (!error) {
          for (const entry of data) {
            if (entry.path && entry.signedUrl && !entry.error) signedByPath.set(entry.path, entry.signedUrl)
          }
        }
      } catch {
        // A thrown call is treated like an error result: every row falls
        // through to null below and reads "Proof unavailable", instead of the
        // rejection leaving them all stuck looking like they are still signing.
      }
    }
    if (seq !== loadSeq.current) return
    setProofUrls(Object.fromEntries(rows.map((r) => [r.id, signedByPath.get(r.proof_path) ?? null])))
  }, [])

  const load = useCallback(async (): Promise<TopupRow[] | null> => {
    const seq = ++loadSeq.current
    let q = supabase.from('topup_requests').select(SELECT)
      .order('created_at', { ascending: false })
    q = filter === 'pending' ? q.eq('status', 'pending') : q.limit(ALL_LIMIT)
    const { data, error } = await q
    if (seq !== loadSeq.current) return null
    // A failed read must not look like an empty queue: keep whatever was
    // loaded before, flag the failure, and let the render say so.
    if (error) {
      setLoadError(errorText(error, 'Unknown error'))
      return null
    }
    // `*` defeats postgrest-js's select-string typing (see AdminOrders), so a
    // direct cast is accurate. amount is normalised in case numeric arrives as
    // a string.
    const rows = ((data as TopupRow[]) ?? []).map((r) => ({ ...r, amount: Number(r.amount) }))
    setLoadError(null)
    setLoaded({ filter, rows })
    void signProofs(rows, seq)
    return rows
  }, [filter, signProofs])

  useEffect(() => { void load() }, [load])

  // Signed URLs last five minutes and new requests arrive while the tab sits
  // in the background, so refresh when the admin comes back to it.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') void load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [load])

  useEffect(() => {
    if (rejectingId) reasonRef.current?.focus()
  }, [rejectingId])

  const rows = loaded?.filter === filter ? loaded.rows : null
  // Rows just approved or rejected are patched in place below, so in the
  // Pending view they must drop out at once rather than wait for the reload.
  const visibleRows = rows && (filter === 'pending' ? rows.filter((r) => r.status === 'pending') : rows)
  // History is ordered by submission time; the ones that still need a decision
  // come first.
  const orderedRows = visibleRows && (filter === 'all'
    ? [...visibleRows.filter((r) => r.status === 'pending'), ...visibleRows.filter((r) => r.status !== 'pending')]
    : visibleRows)

  const patchRow = (id: string, changes: Partial<TopupRow>) => {
    setLoaded((prev) => prev && {
      ...prev,
      rows: prev.rows.map((r) => (r.id === id ? { ...r, ...changes } : r)),
    })
  }

  const openApprove = (row: TopupRow) => {
    setNotice(null)
    setApproveError(null)
    setPendingApprove(row)
  }

  const closeApprove = () => {
    setApproveError(null)
    setPendingApprove(null)
  }

  const openReject = (row: TopupRow) => {
    setNotice(null)
    setRejectError(null)
    setReason('')
    setRejectingId(row.id)
  }

  const closeReject = () => {
    setRejectError(null)
    setReason('')
    setRejectingId(null)
  }

  // The server refused an action. Reload to learn why it matters: if the
  // request is no longer pending (another admin got there first) or can never
  // be approved by this admin, the dialog / form would be left holding a
  // button that can only fail again - so close it and explain at page level.
  // Otherwise (network trouble, say) the control stays open for a retry, with
  // the reason shown inline.
  const settleFailure = async (
    target: TopupRow,
    verb: 'approve' | 'reject',
    message: string,
    closeControl: () => void,
    showInline: (message: string) => void,
  ) => {
    const fresh = await load()
    const settled = fresh !== null && !fresh.some((r) => r.id === target.id && r.status === 'pending')
    if (!settled && message !== OWN_TOPUP_MESSAGE) {
      showInline(message)
      return
    }
    closeControl()
    setNotice(
      `Couldn't ${verb} ${requesterName(target)}'s ${formatPeso(target.amount)} top-up. ${sentence(message)}`
      + (settled ? ' The list has been refreshed.' : ''),
    )
  }

  const doApprove = async () => {
    if (busy || !pendingApprove) return
    const target = pendingApprove
    setBusy(true)
    setNotice(null)
    setApproveError(null)
    try {
      const { error } = await supabase.rpc('approve_topup', { p_id: target.id })
      if (error) {
        await settleFailure(target, 'approve', approveErrorText(error), closeApprove, setApproveError)
        return
      }
      patchRow(target.id, { status: 'approved' })
      setPendingApprove(null)
      void load()
    } finally {
      setBusy(false)
    }
  }

  const doReject = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    const trimmed = reason.trim()
    const target = rows?.find((r) => r.id === rejectingId)
    if (!target || trimmed === '') return
    setBusy(true)
    setNotice(null)
    setRejectError(null)
    try {
      const { error } = await supabase.rpc('reject_topup', { p_id: target.id, p_reason: trimmed })
      if (error) {
        await settleFailure(target, 'reject', errorText(error, 'Could not reject this top-up.'), closeReject, setRejectError)
        return
      }
      patchRow(target.id, { status: 'rejected', reject_reason: trimmed })
      closeReject()
      void load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="p-4 md:p-8 space-y-4 max-w-3xl">
      <h1 className="font-display text-2xl font-bold">Top-ups</h1>

      <div className="flex gap-2 overflow-x-auto pb-1">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => { setNotice(null); setFilter(f.value) }}
            aria-pressed={filter === f.value}
            className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium transition ${
              filter === f.value ? 'bg-ink-900 text-white' : 'bg-surface-raised text-ink-500 shadow-card'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {notice && (
        <p className="rounded-md bg-red-50 p-3 text-sm text-red-600" role="alert">{notice}</p>
      )}

      {loadError && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-600 flex items-center justify-between gap-3" role="alert">
          <p>
            {rows
              ? 'Could not refresh the list — what is shown may be out of date. '
              : 'Could not load top-ups. '}
            <span className="text-red-600/80">{loadError}</span>
          </p>
          <button onClick={() => void load()} className="shrink-0 rounded-full bg-white px-3 py-1.5 text-xs font-medium text-red-600 shadow-card">
            Retry
          </button>
        </div>
      )}

      {orderedRows === null && !loadError && <p className="text-center text-ink-500 py-8">Loading…</p>}

      {orderedRows && orderedRows.length === 0 && !loadError && (
        <div className="text-center py-12 space-y-2">
          <WalletIcon className="size-12 mx-auto text-ink-500" strokeWidth={2.5} aria-hidden="true" />
          <p className="text-ink-700 font-medium">{filter === 'pending' ? 'Nothing to approve' : 'No top-ups yet'}</p>
          <p className="text-ink-500 text-sm">
            {filter === 'pending' ? 'No top-ups are waiting for a decision.' : 'Customer top-up requests will show up here.'}
          </p>
        </div>
      )}

      {orderedRows && orderedRows.length > 0 && (
        <ul className="space-y-2">
          {orderedRows.map((r) => (
            <li key={r.id} className="rounded-lg bg-surface-raised p-3 shadow-card">
              <div className="flex gap-3">
                <ProofThumb
                  url={proofUrls[r.id]}
                  label={`Payment proof from ${requesterName(r)}, ${formatPeso(r.amount)} (opens in new tab)`}
                  onError={() => setProofUrls((prev) => ({ ...prev, [r.id]: null }))}
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">{requesterName(r)}</p>
                      {r.profiles?.full_name && r.profiles.email && (
                        <p className="text-xs text-ink-500 truncate">{r.profiles.email}</p>
                      )}
                    </div>
                    <p className="font-bold tabular-nums shrink-0">{formatPeso(r.amount)}</p>
                  </div>
                  <p className="text-xs text-ink-500">
                    {r.method?.label ?? 'Unknown method'} ·{' '}
                    <time dateTime={r.created_at} title={new Date(r.created_at).toLocaleString()}>
                      {relativeTime(r.created_at)}
                    </time>
                  </p>
                  {r.status === 'approved' && <p className="text-xs font-medium text-green-700">Approved</p>}
                  {r.status === 'rejected' && (
                    <p className="text-xs text-ink-500">
                      <span className="font-medium text-red-600">Rejected</span>
                      {r.reject_reason && <> — {r.reject_reason}</>}
                    </p>
                  )}
                </div>
              </div>

              {r.status === 'pending' && rejectingId !== r.id && (
                <div className="flex flex-wrap items-center justify-end gap-2 pt-3">
                  {/* An admin cannot approve their own top-up (approve_topup refuses it).
                      Reject stays: no money moves, and it is how they clear their own
                      request out of the one-pending-per-user slot. */}
                  {r.user_id === myId && (
                    <p className="mr-auto text-xs text-ink-500">You can&apos;t approve your own top-up</p>
                  )}
                  <button
                    onClick={() => openReject(r)}
                    disabled={busy}
                    className="rounded-full bg-red-50 px-4 py-2.5 text-sm font-medium text-red-600 transition disabled:opacity-50"
                  >
                    Reject
                  </button>
                  {r.user_id !== myId && (
                    <button
                      onClick={() => openApprove(r)}
                      disabled={busy}
                      className="rounded-full bg-green-700 px-4 py-2.5 text-sm font-medium text-white transition disabled:opacity-50"
                    >
                      Approve
                    </button>
                  )}
                </div>
              )}

              {rejectingId === r.id && (
                <form onSubmit={doReject} className="mt-3 border-t border-line pt-3 space-y-2">
                  <label htmlFor={reasonId} className="block text-xs font-medium text-ink-500">
                    Reason — the customer will see this
                  </label>
                  <textarea
                    id={reasonId}
                    ref={reasonRef}
                    rows={3}
                    maxLength={REASON_MAX_LENGTH}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. The amount on the screenshot doesn't match"
                    className={inputCls}
                  />
                  {rejectError && <p className="text-sm text-red-600" role="alert">{rejectError}</p>}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={closeReject}
                      disabled={busy}
                      className="grow rounded-md bg-ink-900/5 py-2.5 text-sm font-medium disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={busy || reason.trim() === ''}
                      className="grow rounded-md bg-red-600 py-2.5 text-sm font-medium text-white disabled:opacity-50"
                    >
                      {busy ? 'Rejecting…' : 'Reject top-up'}
                    </button>
                  </div>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      {filter === 'all' && rows && rows.length >= ALL_LIMIT && (
        <p className="text-center text-xs text-ink-500">Showing the {ALL_LIMIT} most recent top-ups.</p>
      )}

      <ConfirmDialog
        open={pendingApprove !== null}
        title="Approve this top-up?"
        message={
          <>
            {approveError && <p className="text-red-600 mb-2" role="alert">{approveError}</p>}
            Credit <b>{formatPeso(pendingApprove?.amount ?? 0)}</b> to {pendingApprove ? requesterName(pendingApprove) : 'this customer'}.
          </>
        }
        confirmLabel="Approve"
        busy={busy}
        busyLabel="Approving…"
        onConfirm={doApprove}
        onCancel={closeApprove}
      />
    </div>
  )
}

function ProofThumb({ url, label, onError }: { url: string | null | undefined; label: string; onError: () => void }) {
  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title="Open full size"
        aria-label={label}
        className="shrink-0 rounded-md"
      >
        {/* The link's aria-label names the proof; an alt here would only repeat it. */}
        <img src={url} alt="" onError={onError} className="size-16 rounded-md object-cover" />
      </a>
    )
  }
  return (
    <div className="size-16 shrink-0 rounded-md bg-ink-900/5 flex items-center justify-center p-1 text-center text-[10px] leading-tight text-ink-500">
      {url === null ? 'Proof unavailable' : ''}
    </div>
  )
}
