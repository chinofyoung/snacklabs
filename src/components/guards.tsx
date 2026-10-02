import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { Navigate } from 'react-router'
import AccountStatus from './AccountStatus'
import CookieMark from './CookieMark'
import { useAuth } from '../context/AuthContext'

function Splash() {
  return (
    <div className="min-h-dvh flex flex-col items-center justify-center gap-2 text-ink-500">
      <CookieMark className="size-10 animate-pulse" />
      <span className="text-sm">Loading…</span>
    </div>
  )
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, profile, loading, signOut } = useAuth()
  const blocked = !loading && !!session && !!profile?.is_blocked

  useEffect(() => {
    if (blocked) void signOut()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocked])

  if (loading) return <Splash />
  if (!session) return <Navigate to="/login" replace />
  if (blocked) return <Splash />
  // Fail closed: a session whose profile could not be read has unknown
  // approval, which must not be treated as approved.
  if (!profile) return <AccountStatus status="unavailable" />
  // Approval is checked after blocking: a blocked account is signed out
  // outright, which is a harder stop than the status screen.
  if (profile.approval_status === 'pending') return <AccountStatus status="pending" />
  if (profile.approval_status === 'rejected') return <AccountStatus status="rejected" />
  return <>{children}</>
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { session, profile, loading } = useAuth()
  if (loading) return <Splash />
  if (!session) return <Navigate to="/login" replace />
  if (!profile?.is_admin) return <Navigate to="/store" replace />
  return <>{children}</>
}

// Landing hub for "/": once auth resolves, sends admins to the admin
// console, unapproved accounts to their status screen, and everyone else
// to the storefront.
export function HomeRedirect() {
  const { session, profile, loading } = useAuth()
  if (loading) return <Splash />
  if (!session) return <Navigate to="/login" replace />
  if (!profile) return <AccountStatus status="unavailable" />
  if (profile.approval_status === 'pending') return <AccountStatus status="pending" />
  if (profile.approval_status === 'rejected') return <AccountStatus status="rejected" />
  return <Navigate to={profile.is_admin ? '/admin' : '/store'} replace />
}
