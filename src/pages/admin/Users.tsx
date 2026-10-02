import { useEffect, useMemo, useState } from 'react'
import { Ban, Globe, Search, ShieldCheck, UserPlus, UserX, Users as UsersIcon } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import ConfirmDialog from '../../components/ConfirmDialog'
import { formatPeso } from '../../lib/money'
import type { AllowedDomain, PendingRegistration } from '../../types'
import { normalizeDomain, isValidDomain } from '../../lib/emailDomain'

interface UserRow {
  id: string
  email: string
  full_name: string
  is_admin: boolean
  is_blocked: boolean
  // Never 'pending' here: load() leaves pending rows to the queue above the list.
  approval_status: 'approved' | 'rejected'
  created_at: string
}

// A registration waiting in the queue. `is_admin` is not part of PendingRegistration
// because a normal registrant never has it, but an account can be promoted before it
// is confirmed (set_registration_status's own comment calls this out), and the queue
// needs it to know when Reject would be refused.
type PendingRow = PendingRegistration & { is_admin: boolean }

const PAGE_SIZE = 10

// Shown when an admin pastes a full address into the domain box. The stored value
// would be a row that can never match a registrant, so it is refused up front.
const EMAIL_NOT_DOMAIN =
  'Enter a domain only, without an email address — for example example.com'

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
  const [pendingAccess, setPendingAccess] = useState<UserRow | null>(null)
  // How many of `filtered` to render. Paginated client-side (a slice of the already-
  // loaded array) rather than via `.range()` on the query: `filtered` searches the
  // full `users` list below, so if `load()` only fetched the first page server-side,
  // the search box would silently stop finding anyone past row 10. Reset to PAGE_SIZE
  // whenever `query` changes (see effect below) so an expanded view doesn't leave a
  // stale, oddly-deep slice sitting on top of a fresh (usually much shorter) result set.
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

  const [pending, setPending] = useState<PendingRow[]>([])
  const [pendingBusyId, setPendingBusyId] = useState<string | null>(null)
  const [pendingReject, setPendingReject] = useState<PendingRow | null>(null)

  const [domains, setDomains] = useState<AllowedDomain[]>([])
  const [newDomain, setNewDomain] = useState('')
  const [newNote, setNewNote] = useState('')
  const [addBusy, setAddBusy] = useState(false)
  const [removeBusyId, setRemoveBusyId] = useState<string | null>(null)
  const [pendingRemove, setPendingRemove] = useState<AllowedDomain | null>(null)
  // Same client-side slicing as `visibleCount` above, and same reasoning (no search
  // here, but no point paginating the fetch when the whole list is tiny). Deliberately
  // NOT reset by loadDomains(): after an add/remove, `domains.slice(0, domainsVisible)`
  // clamps safely on its own if the array got shorter (no stale/blank rows are possible),
  // and leaving the count alone avoids the more surprising case of a resize collapsing
  // an already-expanded list back down to 10 rows out from under the admin.
  const [domainsVisible, setDomainsVisible] = useState(PAGE_SIZE)

  // Pending registrations are excluded here and shown in their own queue above the
  // list; otherwise a registration would appear in both places at once.
  const load = () =>
    supabase.from('profiles')
      .select('id, email, full_name, is_admin, is_blocked, approval_status, created_at')
      .neq('approval_status', 'pending')
      .order('created_at')
      .then(({ data, error: fetchErr }) => {
        if (fetchErr) {
          setError(fetchErr.message)
          return
        }
        setError(null)
        setUsers((data as UserRow[]) ?? [])
      })

  useEffect(() => { load() }, [])

  const loadPending = () =>
    supabase.from('profiles')
      .select('id, email, full_name, first_name, last_name, is_admin, created_at')
      .eq('approval_status', 'pending')
      .order('created_at')
      .then(({ data, error: fetchErr }) => {
        if (fetchErr) {
          setError(fetchErr.message)
          return
        }
        setPending((data as PendingRow[]) ?? [])
      })

  useEffect(() => { loadPending() }, [])

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
  // `error` state: load() calls setError(null) on success and runs concurrently
  // with the other loaders, so a wallets error would be wiped by whichever
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

  const loadDomains = () =>
    supabase.from('allowed_email_domains').select('id, domain, note, created_at').order('domain')
      .then(({ data, error: fetchErr }) => {
        if (fetchErr) {
          setError(fetchErr.message)
          return
        }
        setDomains((data as AllowedDomain[]) ?? [])
      })

  useEffect(() => { loadDomains() }, [])

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
  const visibleDomains = domains.slice(0, domainsVisible)

  const trimmedNewDomain = normalizeDomain(newDomain)
  const isNewDomainValid = isValidDomain(trimmedNewDomain)
  // Live guidance for the one mistake worth naming. The Add button is disabled for an
  // invalid value, so a message that only appeared on click would never be seen.
  const domainHint = trimmedNewDomain.includes('@') ? EMAIL_NOT_DOMAIN : null

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

  // Revoking is a property of the account, not of an address: the per-address
  // allowlist is gone, so this is the only way to block someone.
  const setAccess = async (user: UserRow, allowed: boolean) => {
    setBusyId(user.id)
    setError(null)
    const { error: rpcErr } = await supabase.rpc('set_user_access', {
      p_user_id: user.id,
      p_allowed: allowed,
    })
    if (rpcErr) {
      setError(rpcErr.message)
      setBusyId(null)
      return
    }
    await load()
    setBusyId(null)
  }

  // Shared by the queue (confirm / reject) and by the user list (re-confirm someone who
  // was rejected). Both lists change either way: an approved registrant becomes a listed
  // user, and a rejected one leaves the queue for the list. The caller owns its own busy
  // flag, since the queue and the list track theirs separately.
  const applyRegistrationStatus = async (userId: string, status: 'approved' | 'rejected') => {
    setError(null)
    const { error: rpcErr } = await supabase.rpc('set_registration_status', {
      p_user_id: userId,
      p_status: status,
    })
    if (rpcErr) {
      setError(rpcErr.message)
      return
    }
    await Promise.all([loadPending(), load()])
  }

  const decide = async (row: PendingRow, status: 'approved' | 'rejected') => {
    setPendingBusyId(row.id)
    await applyRegistrationStatus(row.id, status)
    setPendingBusyId(null)
  }

  // The way back from Reject. set_registration_status permits confirming anyone; only
  // rejecting an admin is refused.
  const reconfirm = async (user: UserRow) => {
    setBusyId(user.id)
    await applyRegistrationStatus(user.id, 'approved')
    setBusyId(null)
  }

  const addDomain = async () => {
    const domain = normalizeDomain(newDomain)
    if (!isValidDomain(domain)) {
      setError(domain.includes('@') ? EMAIL_NOT_DOMAIN : 'Enter a valid domain, for example example.com')
      return
    }
    setAddBusy(true)
    setError(null)
    const { error: insErr } = await supabase.from('allowed_email_domains')
      .insert({ domain, note: newNote.trim() })
    if (insErr) {
      // 23505 = unique_violation: the domain column is unique and already stored lowercase.
      setError(insErr.code === '23505' ? 'That domain is already on the list.' : insErr.message)
      setAddBusy(false)
      return
    }
    setNewDomain('')
    setNewNote('')
    await loadDomains()
    setAddBusy(false)
  }

  const removeDomain = async (entry: AllowedDomain) => {
    setRemoveBusyId(entry.id)
    setError(null)
    const { error: delErr } = await supabase.from('allowed_email_domains').delete().eq('id', entry.id)
    if (delErr) {
      setError(delErr.message)
      setRemoveBusyId(null)
      return
    }
    await loadDomains()
    setRemoveBusyId(null)
  }

  return (
    <div className="p-4 md:p-8 space-y-4 max-w-3xl">
      <h1 className="font-display text-2xl font-bold">Users</h1>

      {pending.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-display text-lg font-bold flex items-center gap-1.5">
            <UserPlus className="size-5 text-brand-600" strokeWidth={2.5} aria-hidden="true" />
            Pending registrations
            <span className="rounded-full bg-brand-50 text-brand-700 text-[10px] font-medium px-2 py-0.5">
              {pending.length}
            </span>
          </h2>
          <p className="text-sm text-ink-500">
            These people registered and are waiting to be confirmed. They cannot sign in to the
            store until you confirm them.
          </p>
          {pending.map((p) => {
            const busy = pendingBusyId === p.id
            return (
              <div key={p.id} className="rounded-lg bg-surface-raised p-3 shadow-card flex items-center gap-3">
                <div className="grow min-w-0">
                  <p className="font-medium text-sm truncate">{p.full_name || p.email}</p>
                  <p className="text-xs text-ink-500 truncate">{p.email}</p>
                  {/* Absolute timestamp, as AdminOrders shows: the register endpoint is
                      unauthenticated, so a burst of junk sign-ups is only visible if the
                      admin can see when each one arrived. */}
                  <p className="text-xs text-ink-500 truncate">
                    Registered{' '}
                    <time dateTime={p.created_at}>{new Date(p.created_at).toLocaleString()}</time>
                  </p>
                </div>
                {/* set_registration_status refuses to reject an admin (it would strand
                    them behind the rejected screen) but permits confirming one, so only
                    Reject is withheld. */}
                {!p.is_admin && (
                  <button
                    onClick={() => setPendingReject(p)}
                    disabled={busy}
                    className="shrink-0 text-sm text-red-500 px-2 py-1.5 rounded-md hover:bg-red-50 disabled:opacity-50"
                  >
                    Reject
                  </button>
                )}
                <button
                  onClick={() => decide(p, 'approved')}
                  disabled={busy}
                  className="shrink-0 text-sm bg-brand-700 text-white px-3 py-1.5 rounded-md font-medium disabled:opacity-50"
                >
                  {busy ? 'Working…' : 'Confirm'}
                </button>
              </div>
            )
          })}
        </section>
      )}

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
              const rejected = u.approval_status === 'rejected'
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
                        chip and truncates emails on admin rows at phone widths. The Rejected
                        and Revoked chips live on this line for the same reason (and wrap
                        rather than shrink the name when a row carries both). */}
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="block text-sm font-bold text-brand-700 tabular-nums">
                        <span className="sr-only">Wallet balance </span>
                        {balances ? formatPeso(balances[u.id] ?? 0) : '—'}
                      </span>
                      {rejected && (
                        <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-red-50 text-red-600 text-[10px] font-medium px-2 py-1">
                          <UserX className="size-3.5" strokeWidth={2.5} aria-hidden="true" />
                          Rejected
                        </span>
                      )}
                      {u.is_blocked && (
                        <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-red-50 text-red-600 text-[10px] font-medium px-2 py-1">
                          <Ban className="size-3.5" strokeWidth={2.5} aria-hidden="true" />
                          Revoked
                        </span>
                      )}
                    </div>
                  </div>
                  {u.is_admin && (
                    <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-brand-50 text-brand-700 text-[10px] font-medium px-2 py-1">
                      <ShieldCheck className="size-3.5" strokeWidth={2.5} aria-hidden="true" />
                      Admin
                    </span>
                  )}
                  {/* Actions stack on phones and sit side by side from `sm` up: two buttons
                      in a row cost the name block ~70px more, which is the squeeze the
                      comment above describes. Stacked, they are about as tall as the
                      name block, so the row barely grows. */}
                  <div className="shrink-0 flex flex-col items-stretch gap-1 sm:flex-row sm:items-center sm:gap-3">
                    {u.is_admin ? (
                      <button
                        onClick={() => setPendingRevoke(u)}
                        disabled={busy}
                        className="shrink-0 text-sm text-red-500 px-2 py-1.5 rounded-md hover:bg-red-50 disabled:opacity-50"
                      >
                        {busy ? 'Working…' : 'Revoke admin'}
                      </button>
                    ) : (
                      !rejected && (
                        <button
                          onClick={() => setAdmin(u, true)}
                          disabled={busy}
                          className="shrink-0 text-sm bg-ink-900 text-white px-3 py-1.5 rounded-md font-medium disabled:opacity-50"
                        >
                          {busy ? 'Working…' : 'Make admin'}
                        </button>
                      )
                    )}
                    {/* A rejected account is offered the way back instead of the controls
                        below: promoting or revoking someone who cannot sign in anyway
                        would only add a second state to untangle. */}
                    {rejected && (
                      <button
                        onClick={() => reconfirm(u)}
                        disabled={busy}
                        className="shrink-0 text-sm text-brand-700 px-2 py-1.5 rounded-md hover:bg-brand-50 disabled:opacity-50"
                      >
                        {busy ? 'Working…' : 'Confirm'}
                      </button>
                    )}
                    {/* An admin cannot be blocked — set_user_access refuses it — so the
                        control is hidden for admins rather than offered and then rejected. */}
                    {!u.is_admin && !rejected && (
                      u.is_blocked ? (
                        <button
                          onClick={() => setAccess(u, true)}
                          disabled={busy}
                          className="shrink-0 text-sm text-brand-700 px-2 py-1.5 rounded-md hover:bg-brand-50 disabled:opacity-50"
                        >
                          {busy ? 'Working…' : 'Restore'}
                        </button>
                      ) : (
                        <button
                          onClick={() => setPendingAccess(u)}
                          disabled={busy}
                          className="shrink-0 text-sm text-red-500 px-2 py-1.5 rounded-md hover:bg-red-50 disabled:opacity-50"
                        >
                          Revoke
                        </button>
                      )
                    )}
                  </div>
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
        open={pendingReject !== null}
        destructive
        title="Reject registration?"
        message={
          <>
            Reject <b>{pendingReject?.full_name || pendingReject?.email}</b>? They will not be able
            to sign in to the store. You can confirm them later from the user list below.
          </>
        }
        confirmLabel="Reject"
        busy={pendingBusyId === pendingReject?.id}
        busyLabel="Rejecting…"
        onConfirm={async () => {
          if (pendingReject) await decide(pendingReject, 'rejected')
          setPendingReject(null)
        }}
        onCancel={() => setPendingReject(null)}
      />

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

      <ConfirmDialog
        open={pendingAccess !== null}
        destructive
        title="Revoke access?"
        message={
          <>
            Revoke access for <b>{pendingAccess?.full_name || pendingAccess?.email}</b>? They will be
            signed out and cannot sign in again until you restore them. Their account and order
            history are kept.
          </>
        }
        confirmLabel="Revoke"
        busy={busyId === pendingAccess?.id}
        busyLabel="Revoking…"
        onConfirm={async () => {
          if (pendingAccess) await setAccess(pendingAccess, false)
          setPendingAccess(null)
        }}
        onCancel={() => setPendingAccess(null)}
      />

      <h2 className="font-display text-lg font-bold pt-2 flex items-center gap-1.5">
        <Globe className="size-5 text-brand-600" strokeWidth={2.5} aria-hidden="true" />
        Allowed domains
      </h2>
      <p className="text-sm text-ink-500">
        Anyone with an email at one of these domains can register. They still need to be
        confirmed above before they can sign in. This list is never shown to users.
      </p>

      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          value={newDomain}
          onChange={(e) => setNewDomain(e.target.value)}
          placeholder="example.com"
          aria-label="Domain"
          aria-describedby={domainHint ? 'domain-hint' : undefined}
          className="grow rounded-md bg-surface-raised border border-line px-3 py-2.5 text-sm outline-none focus-visible:outline-2 focus-visible:outline-brand-700"
        />
        <input
          type="text"
          value={newNote}
          onChange={(e) => setNewNote(e.target.value)}
          placeholder="Note (optional)"
          aria-label="Note"
          className="grow rounded-md bg-surface-raised border border-line px-3 py-2.5 text-sm outline-none focus-visible:outline-2 focus-visible:outline-brand-700"
        />
        <button
          onClick={addDomain}
          disabled={addBusy || !isNewDomainValid}
          className="shrink-0 text-sm bg-brand-700 text-white px-3 py-1.5 rounded-md font-medium disabled:opacity-50"
        >
          {addBusy ? 'Adding…' : 'Add'}
        </button>
      </div>
      {domainHint && <p id="domain-hint" className="text-sm text-red-600">{domainHint}</p>}

      {domains.length === 0 ? (
        <p className="text-sm text-ink-500">No allowed domains yet — nobody can register.</p>
      ) : (
        <>
          <div className="space-y-2">
            {visibleDomains.map((entry) => {
              const busy = removeBusyId === entry.id
              return (
                <div key={entry.id} className="rounded-lg bg-surface-raised p-3 shadow-card flex items-center gap-3">
                  <div className="grow min-w-0">
                    <p className="font-medium text-sm truncate flex items-center gap-1.5">
                      <Globe className="size-3.5 text-ink-500 shrink-0" strokeWidth={2.5} aria-hidden="true" />
                      {entry.domain}
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
            Showing {visibleDomains.length} of {domains.length} domain{domains.length === 1 ? '' : 's'}
          </p>
          {domains.length > domainsVisible && (
            <button
              onClick={() => setDomainsVisible((c) => c + PAGE_SIZE)}
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
        title="Remove allowed domain?"
        message={
          <>
            Remove <b>{pendingRemove?.domain}</b>? Nobody at that domain will be able to register.
            People from it who already have confirmed accounts keep their access.
          </>
        }
        confirmLabel="Remove"
        busy={removeBusyId === pendingRemove?.id}
        busyLabel="Removing…"
        onConfirm={async () => {
          if (pendingRemove) await removeDomain(pendingRemove)
          setPendingRemove(null)
        }}
        onCancel={() => setPendingRemove(null)}
      />
    </div>
  )
}
