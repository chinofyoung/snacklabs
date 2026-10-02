import { useState } from 'react'
import { CircleUser } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import PushToggle from '../components/PushToggle'

export default function CustomerSettings() {
  const { profile, signOut } = useAuth()
  // Signing out can wait on the push teardown (bounded at a few seconds), so the
  // button has to show it is working or it reads as broken and gets tapped again.
  const [signingOut, setSigningOut] = useState(false)

  const handleSignOut = async () => {
    setSigningOut(true)
    try {
      await signOut()
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <div className="max-w-md mx-auto px-4 py-4 space-y-5 pb-28 app-frame">
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

      <section className="rounded-lg bg-surface-raised p-4 shadow-card">
        <PushToggle />
      </section>

      <button
        type="button"
        onClick={() => void handleSignOut()}
        disabled={signingOut}
        className="w-full rounded-lg bg-ink-900 text-white py-4 font-bold active:scale-[0.98] transition disabled:opacity-50"
      >
        {signingOut ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
  )
}
