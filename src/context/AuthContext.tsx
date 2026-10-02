import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import type { ApprovalStatus } from '../types'

export interface Profile {
  id: string
  email: string
  full_name: string
  first_name: string
  last_name: string
  avatar_url: string | null
  is_admin: boolean
  is_blocked: boolean
  approval_status: ApprovalStatus
}

interface AuthState {
  session: Session | null
  profile: Profile | null
  loading: boolean
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState>({
  session: null, profile: null, loading: true, signOut: async () => {},
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  // Id of the user whose profile fetch has settled, successfully or not. Lets
  // `loading` stay true between a session appearing and its profile arriving,
  // so consumers never see "session, no profile" mid sign-in and mistake it for
  // a failed fetch.
  const [profileSettledFor, setProfileSettledFor] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      if (!data.session) setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s)
      if (!s) { setProfile(null); setProfileSettledFor(null); setLoading(false) }
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session) return
    let ignore = false
    supabase.from('profiles').select('*').eq('id', session.user.id).single()
      .then(({ data }) => {
        if (ignore) return
        setProfile(data as Profile | null)
        setProfileSettledFor(session.user.id)
        setLoading(false)
      })
    return () => { ignore = true }
  }, [session])

  const signOut = async () => { await supabase.auth.signOut() }

  const awaitingProfile = !!session && profileSettledFor !== session.user.id

  return (
    <AuthContext.Provider value={{ session, profile, loading: loading || awaitingProfile, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  return useContext(AuthContext)
}
