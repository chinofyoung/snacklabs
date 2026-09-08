import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

export interface Profile {
  id: string
  email: string
  full_name: string
  avatar_url: string | null
  is_admin: boolean
  is_blocked: boolean
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

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      if (!data.session) setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s)
      if (!s) { setProfile(null); setLoading(false) }
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
        setLoading(false)
      })
    return () => { ignore = true }
  }, [session])

  const signOut = async () => { await supabase.auth.signOut() }

  return (
    <AuthContext.Provider value={{ session, profile, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  return useContext(AuthContext)
}
