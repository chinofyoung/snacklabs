import { useEffect, useMemo, useState } from 'react'
import { Search, ShieldCheck, Users as UsersIcon } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import ConfirmDialog from '../../components/ConfirmDialog'

interface UserRow {
  id: string
  email: string
  full_name: string
  is_admin: boolean
  created_at: string
}

export default function Users() {
  const { profile } = useAuth()
  const [users, setUsers] = useState<UserRow[]>([])
  const [query, setQuery] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingRevoke, setPendingRevoke] = useState<UserRow | null>(null)

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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return users
    return users.filter((u) =>
      u.full_name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
    )
  }, [users, query])

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

  return (
    <div className="p-4 md:p-8 space-y-4 max-w-3xl">
      <h1 className="font-display text-2xl font-bold">Users</h1>

      <div className="relative">
        <Search className="size-4 text-ink-500 absolute left-3 top-1/2 -translate-y-1/2" strokeWidth={2.5} aria-hidden="true" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or email"
          className="w-full rounded-md bg-surface-raised border border-line pl-9 pr-3 py-2.5 text-sm outline-none focus-visible:outline-2 focus-visible:outline-brand-500"
        />
      </div>

      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}

      {filtered.length === 0 ? (
        <div className="text-center py-12 space-y-2">
          <UsersIcon className="size-12 mx-auto text-ink-500" strokeWidth={2.5} aria-hidden="true" />
          <p className="text-ink-700 font-medium">No users found</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((u) => {
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
                </div>
                {u.is_admin && (
                  <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-brand-50 text-brand-600 text-[10px] font-medium px-2 py-1">
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
    </div>
  )
}
