import { useEffect, useMemo, useState } from 'react'
import { Mail, Search, ShieldCheck, Users as UsersIcon } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import ConfirmDialog from '../../components/ConfirmDialog'
import { formatPeso } from '../../lib/money'
import type { EmailAllowlistEntry } from '../../types'

interface UserRow {
  id: string
  email: string
  full_name: string
  is_admin: boolean
  created_at: string
}

const PAGE_SIZE = 10

export default function Users() {
  const { profile } = useAuth()
  const [users, setUsers] = useState<UserRow[]>([])
  // Wallet balance by user id. Display only — balances change through the top-up
  // approval and checkout flows, never from this page.
  // null = not loaded yet, the fetch failed, or it came back empty. Deliberately
  // NOT {}: this is a money column, and the migration backfills a wallets row for
  // every user, so a false ₱0.00 is indistinguishable from a real zero balance. A
  // dash says "no data"; a zero makes a claim we cannot back. Mirrors
  // src/pages/Wallet.tsx.
  const [balances, setBalances] = useState<Record<string, number> | null>(null)
  const [query, setQuery] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingRevoke, setPendingRevoke] = useState<UserRow | null>(null)
  // How many of `filtered` to render. Paginated client-side (a slice of the already-
  // loaded array) rather than via `.range()` on the query: `filtered` searches the
  // full `users` list below, so if `load()` only fetched the first page server-side,
  // the search box would silently stop finding anyone past row 10. Reset to PAGE_SIZE
  // whenever `query` changes (see effect below) so an expanded view doesn't leave a
  // stale, oddly-deep slice sitting on top of a fresh (usually much shorter) result set.
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

  const [allowlist, setAllowlist] = useState<EmailAllowlistEntry[]>([])
  const [newEmail, setNewEmail] = useState('')
  const [newNote, setNewNote] = useState('')
  const [addBusy, setAddBusy] = useState(false)
  const [removeBusyId, setRemoveBusyId] = useState<string | null>(null)
  const [pendingRemove, setPendingRemove] = useState<EmailAllowlistEntry | null>(null)
  const [allowlistMessage, setAllowlistMessage] = useState<string | null>(null)
  // Same client-side slicing as `visibleCount` above, and same reasoning (no search
  // here, but no point paginating the fetch when the whole list is tiny). Deliberately
  // NOT reset by loadAllowlist(): after an add/remove, `allowlist.slice(0, allowlistVisible)`
  // clamps safely on its own if the array got shorter (no stale/blank rows are possible),
  // and leaving the count alone avoids the more surprising case of a resize collapsing
  // an already-expanded list back down to 10 rows out from under the admin.
  const [allowlistVisible, setAllowlistVisible] = useState(PAGE_SIZE)

  const load = () =>
    supabase.from('profiles').select('id, email, full_name, is_admin, created_at').order('created_at')
      .then(({ data, error: fetchErr }) => {
        if (fetchErr) {
          setError(fetchErr.message)
          return
        }
        setError(null)
        setUsers((data as UserRow[]) ?? [])
      })

  useEffect(() => { load() }, [])

  // No `user_id` filter: an admin session can read every wallets row by RLS policy,
  // which is exactly what this page needs.
  //
  // Leaves `balances` null, and so shows dashes, for BOTH a transport error AND an
  // empty result. The empty case is the dangerous one: when RLS filters a read to
  // nothing, PostgREST answers 200 with `error: null` and `data: []`, so an error
  // check alone never fires, and Object.fromEntries([]) is `{}`, which is truthy,
  // so the render's `balances ? ... : '—'` would print ₱0.00 for every user. Zero
  // rows is never a real answer here: the migration backfills a wallets row for
  // every profile, and the admin viewing this page is itself a profile. A
  // genuinely empty user list needs no special case, since it renders "No users
  // found" and no balance cells, so the null map is never read.
  //
  // Failure is reported by leaving `balances` null rather than via the shared
  // `error` state: load() and loadAllowlist() each setError(null) on success and
  // all three run concurrently, so a wallets error would be wiped by whichever
  // sibling resolves last.
  const loadBalances = () =>
    supabase.from('wallets').select('user_id, balance')
      .then(({ data, error: fetchErr }) => {
        if (fetchErr || !data?.length) return // leave null; never write {} on failure or on an empty result
        // `balance` may arrive as a string or a number depending on how the numeric
        // column is encoded over the wire; Number() normalises both.
        setBalances(Object.fromEntries(
          (data as { user_id: string; balance: number | string }[])
            .map((w) => [w.user_id, Number(w.balance)])))
      })

  useEffect(() => { loadBalances() }, [])

  const loadAllowlist = () =>
    supabase.from('email_allowlist').select('id, email, note, created_at').order('created_at')
      .then(({ data, error: fetchErr }) => {
        if (fetchErr) {
          setError(fetchErr.message)
          return
        }
        setError(null)
        setAllowlist((data as EmailAllowlistEntry[]) ?? [])
      })

  useEffect(() => { loadAllowlist() }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return users
    return users.filter((u) =>
      u.full_name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
    )
  }, [users, query])

  // A fresh search term can match far fewer rows than were previously revealed —
  // without this, expanding to 40 rows then typing a query that matches 3 people
  // would silently keep slicing at 40 (harmless here, but pointless) instead of
  // starting the new result set back at a single page.
  useEffect(() => { setVisibleCount(PAGE_SIZE) }, [query])

  const visibleUsers = filtered.slice(0, visibleCount)
  const visibleAllowlist = allowlist.slice(0, allowlistVisible)

  const trimmedNewEmail = newEmail.trim().toLowerCase()
  const isNewEmailValid = trimmedNewEmail.length > 0 && trimmedNewEmail.includes('@')

  const setAdmin = async (user: UserRow, isAdmin: boolean) => {
    setBusyId(user.id)
    setError(null)
    const { error: upErr } = await supabase.from('profiles').update({ is_admin: isAdmin }).eq('id', user.id)
    if (upErr) {
      setError(upErr.message)
      setBusyId(null)
      return
    }
    await load()
    setBusyId(null)
  }

  const addEmail = async () => {
    const email = newEmail.trim().toLowerCase()
    if (!email || !email.includes('@')) {
      setError('Enter a valid email address')
      return
    }
    setAddBusy(true)
    setError(null)
    const { data, error: rpcErr } = await supabase.rpc('set_email_access', {
      p_email: email,
      p_allowed: true,
      p_note: newNote.trim(),
    })
    if (rpcErr) {
      setError(rpcErr.message)
      setAddBusy(false)
      return
    }
    setAllowlistMessage(data as string)
    setNewEmail('')
    setNewNote('')
    await loadAllowlist()
    setAddBusy(false)
  }

  const removeEmail = async (entry: EmailAllowlistEntry) => {
    setRemoveBusyId(entry.id)
    setError(null)
    const { data, error: rpcErr } = await supabase.rpc('set_email_access', {
      p_email: entry.email,
      p_allowed: false,
    })
    if (rpcErr) {
      setError(rpcErr.message)
      setRemoveBusyId(null)
      return
    }
    setAllowlistMessage(data as string)
    await loadAllowlist()
    setRemoveBusyId(null)
  }

  return (
    <div className="p-4 md:p-8 space-y-4 max-w-3xl">
      <h1 className="font-display text-2xl font-bold">Users</h1>

      <div className="relative">
        <Search className="size-4 text-ink-500 absolute left-3 top-1/2 -translate-y-1/2" strokeWidth={2.5} aria-hidden="true" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or email"
          className="w-full rounded-md bg-surface-raised border border-line pl-9 pr-3 py-2.5 text-sm outline-none focus-visible:outline-2 focus-visible:outline-brand-700"
        />
      </div>

      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}

      {filtered.length === 0 ? (
        <div className="text-center py-12 space-y-2">
          <UsersIcon className="size-12 mx-auto text-ink-500" strokeWidth={2.5} aria-hidden="true" />
          <p className="text-ink-700 font-medium">No users found</p>
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {visibleUsers.map((u) => {
              const isYou = profile?.id === u.id
              const busy = busyId === u.id
              return (
                <div key={u.id} className="rounded-lg bg-surface-raised p-3 shadow-card flex items-center gap-3">
                  <div className="grow min-w-0">
                    <p className="font-medium text-sm truncate flex items-center gap-1.5">
                      {u.full_name || u.email}
                      {isYou && (
                        <span className="rounded-full bg-ink-900/5 text-ink-500 text-[10px] font-medium px-1.5 py-0.5">You</span>
                      )}
                    </p>
                    <p className="text-xs text-ink-500 truncate">{u.email}</p>
                    {/* Stacked under the email rather than as a trailing column: a sibling
                        span here narrows the name block by ~70px, which clips the "You"
                        chip and truncates emails on admin rows at phone widths. */}
                    <span className="block text-sm font-bold text-brand-700 tabular-nums">
                      <span className="sr-only">Wallet balance </span>
                      {balances ? formatPeso(balances[u.id] ?? 0) : '—'}
                    </span>
                  </div>
                  {u.is_admin && (
                    <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-brand-50 text-brand-700 text-[10px] font-medium px-2 py-1">
                      <ShieldCheck className="size-3.5" strokeWidth={2.5} aria-hidden="true" />
                      Admin
                    </span>
                  )}
                  {u.is_admin ? (
                    <button
                      onClick={() => setPendingRevoke(u)}
                      disabled={busy}
                      className="shrink-0 text-sm text-red-500 px-2 py-1.5 rounded-md hover:bg-red-50 disabled:opacity-50"
                    >
                      {busy ? 'Working…' : 'Revoke admin'}
                    </button>
                  ) : (
                    <button
                      onClick={() => setAdmin(u, true)}
                      disabled={busy}
                      className="shrink-0 text-sm bg-ink-900 text-white px-3 py-1.5 rounded-md font-medium disabled:opacity-50"
                    >
                      {busy ? 'Working…' : 'Make admin'}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          <p className="text-xs text-ink-500">
            Showing {visibleUsers.length} of {filtered.length} user{filtered.length === 1 ? '' : 's'}
          </p>
          {filtered.length > visibleCount && (
            <button
              onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
              className="w-full rounded-2xl bg-white shadow-sm py-3.5 font-medium text-ink-900 active:scale-[0.98] transition"
            >
              Show more
            </button>
          )}
        </>
      )}

      <ConfirmDialog
        open={pendingRevoke !== null}
        destructive
        title="Revoke admin access?"
        message={<>Revoke admin access for <b>{pendingRevoke?.full_name || pendingRevoke?.email}</b>?</>}
        confirmLabel="Revoke"
        busy={busyId === pendingRevoke?.id}
        busyLabel="Revoking…"
        onConfirm={async () => {
          if (pendingRevoke) await setAdmin(pendingRevoke, false)
          setPendingRevoke(null)
        }}
        onCancel={() => setPendingRevoke(null)}
      />

      <h2 className="font-display text-lg font-bold pt-2">Allowed emails</h2>
      <p className="text-sm text-ink-500">
        Emails below may sign in even though they aren't @goabroad.com addresses.
      </p>

      {allowlistMessage && (
        <span className="text-sm text-green-600 font-medium">{allowlistMessage}</span>
      )}

      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="email"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          placeholder="Email address"
          className="grow rounded-md bg-surface-raised border border-line px-3 py-2.5 text-sm outline-none focus-visible:outline-2 focus-visible:outline-brand-700"
        />
        <input
          type="text"
          value={newNote}
          onChange={(e) => setNewNote(e.target.value)}
          placeholder="Note (optional)"
          className="grow rounded-md bg-surface-raised border border-line px-3 py-2.5 text-sm outline-none focus-visible:outline-2 focus-visible:outline-brand-700"
        />
        <button
          onClick={addEmail}
          disabled={addBusy || !isNewEmailValid}
          className="shrink-0 text-sm bg-brand-700 text-white px-3 py-1.5 rounded-md font-medium disabled:opacity-50"
        >
          {addBusy ? 'Adding…' : 'Add'}
        </button>
      </div>

      {allowlist.length === 0 ? (
        <p className="text-sm text-ink-500">No allowed emails yet</p>
      ) : (
        <>
          <div className="space-y-2">
            {visibleAllowlist.map((entry) => {
              const busy = removeBusyId === entry.id
              return (
                <div key={entry.id} className="rounded-lg bg-surface-raised p-3 shadow-card flex items-center gap-3">
                  <div className="grow min-w-0">
                    <p className="font-medium text-sm truncate flex items-center gap-1.5">
                      <Mail className="size-3.5 text-ink-500 shrink-0" strokeWidth={2.5} aria-hidden="true" />
                      {entry.email}
                    </p>
                    {entry.note && <p className="text-xs text-ink-500 truncate">{entry.note}</p>}
                  </div>
                  <button
                    onClick={() => setPendingRemove(entry)}
                    disabled={busy}
                    className="shrink-0 text-sm text-red-500 px-2 py-1.5 rounded-md hover:bg-red-50 disabled:opacity-50"
                  >
                    {busy ? 'Working…' : 'Remove'}
                  </button>
                </div>
              )
            })}
          </div>
          <p className="text-xs text-ink-500">
            Showing {visibleAllowlist.length} of {allowlist.length} email{allowlist.length === 1 ? '' : 's'}
          </p>
          {allowlist.length > allowlistVisible && (
            <button
              onClick={() => setAllowlistVisible((c) => c + PAGE_SIZE)}
              className="w-full rounded-2xl bg-white shadow-sm py-3.5 font-medium text-ink-900 active:scale-[0.98] transition"
            >
              Show more
            </button>
          )}
        </>
      )}

      <ConfirmDialog
        open={pendingRemove !== null}
        destructive
        title="Remove allowed email?"
        message={
          <>
            Remove <b>{pendingRemove?.email}</b> from the allowlist? They will lose sign-in access,
            but their account and order history are kept.
          </>
        }
        confirmLabel="Remove"
        busy={removeBusyId === pendingRemove?.id}
        busyLabel="Removing…"
        onConfirm={async () => {
          if (pendingRemove) await removeEmail(pendingRemove)
          setPendingRemove(null)
        }}
        onCancel={() => setPendingRemove(null)}
      />
    </div>
  )
}
