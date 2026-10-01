import { Link } from 'react-router'
import { ChevronRight, CircleUser } from 'lucide-react'
import { useAuth } from '../context/AuthContext'

const rowCls = 'rounded-lg bg-surface-raised p-4 shadow-card flex items-center justify-between'

interface SettingsLinkProps {
  to: string
  label: string
}

function SettingsLink({ to, label }: SettingsLinkProps) {
  return (
    <li>
      <Link to={to} className={rowCls}>
        <span className="font-medium">{label}</span>
        <ChevronRight className="size-5 text-ink-500" strokeWidth={2.5} aria-hidden="true" />
      </Link>
    </li>
  )
}

export default function CustomerSettings() {
  const { profile, signOut } = useAuth()

  return (
    <div className="max-w-md mx-auto min-h-dvh px-4 py-4 space-y-5 pb-28 app-frame">
      <header>
        <h1 className="font-display text-xl font-bold">Settings</h1>
      </header>

      <div className="rounded-lg bg-surface-raised p-4 shadow-card flex items-center gap-4">
        {profile?.avatar_url ? (
          <img
            src={profile.avatar_url}
            alt=""
            referrerPolicy="no-referrer"
            className="size-14 rounded-full object-cover shrink-0"
          />
        ) : (
          <CircleUser className="size-14 text-ink-500 shrink-0" strokeWidth={1.5} aria-hidden="true" />
        )}
        <div className="min-w-0">
          <p className="font-bold truncate">{profile?.full_name}</p>
          <p className="text-sm text-ink-500 truncate">{profile?.email}</p>
        </div>
      </div>

      {/* The old Store header link is gone, so this row is the only in-app path
          from the customer side back to /admin. Rendered only for admins: with the
          legal rows removed it is the list's sole entry, and an empty <ul> would
          otherwise sit in the accessibility tree for every customer. role="list"
          is explicit because Tailwind's preflight sets list-style:none, and
          Safari/VoiceOver then drop list semantics without it.
          Privacy and Terms are still routed and still linked from Login.tsx. */}
      {profile?.is_admin && (
        <ul role="list" className="space-y-2">
          <SettingsLink to="/admin" label="Admin console" />
        </ul>
      )}

      <button
        type="button"
        onClick={() => { void signOut() }}
        className="w-full rounded-lg bg-ink-900 text-white py-4 font-bold active:scale-[0.98] transition"
      >
        Sign out
      </button>
    </div>
  )
}
