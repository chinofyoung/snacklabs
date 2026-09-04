import type { ReactNode } from 'react'
import { Navigate } from 'react-router'
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
  const { session, loading } = useAuth()
  if (loading) return <Splash />
  if (!session) return <Navigate to="/login" replace />
  return <>{children}</>
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { session, profile, loading } = useAuth()
  if (loading) return <Splash />
  if (!session) return <Navigate to="/login" replace />
  if (!profile?.is_admin) return <Navigate to="/" replace />
  return <>{children}</>
}
