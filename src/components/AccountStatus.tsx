import CookieMark from './CookieMark'
import { useAuth } from '../context/AuthContext'

// Shown to a signed-in account that may not use the app. Deliberately a full
// screen rather than a toast: there is nothing else this session may do, and
// RLS enforces that regardless of what is rendered here.
//
// 'unavailable' is the fail-closed case: a session exists but its profile could
// not be read, so approval is unknown and is treated as not granted.
type Status = 'pending' | 'rejected' | 'unavailable'

const COPY: Record<Status, { title: string; body: string }> = {
  pending: {
    title: 'Waiting for confirmation',
    body: 'Your account has been created. An administrator needs to confirm it before you can start shopping.',
  },
  rejected: {
    title: 'Registration not approved',
    body: 'Your registration was not approved. Check with your administrator if you think this is a mistake.',
  },
  unavailable: {
    title: "Couldn't load your account",
    body: 'Something went wrong while loading your account. Reload the page to try again, or sign out.',
  },
}

export default function AccountStatus({ status }: { status: Status }) {
  const { signOut } = useAuth()
  const { title, body } = COPY[status]

  return (
    // app-frame supplies the light surface: on desktop the body is the dark
    // backdrop, and ink text without it would be unreadable.
    <div className="max-w-md mx-auto min-h-dvh flex flex-col items-center justify-center gap-4 px-6 text-center app-frame">
      <CookieMark className="size-12 text-brand-600" />
      <h1 className="font-display text-xl font-bold">{title}</h1>
      <p className="text-sm text-ink-500 max-w-xs">{body}</p>
      <button
        type="button"
        onClick={() => void signOut()}
        className="rounded-lg bg-ink-900 text-white px-5 py-3 font-bold active:scale-[0.98] transition"
      >
        Sign out
      </button>
    </div>
  )
}
