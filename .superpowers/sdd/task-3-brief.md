### Task 3: Auth — Google sign-in, AuthContext, route guards, app shell routing

**Files:**
- Create: `src/context/AuthContext.tsx`, `src/pages/Login.tsx`, `src/components/guards.tsx`
- Modify: `src/main.tsx`, `src/App.tsx`

**Interfaces:**
- Consumes: `supabase` from Task 1.
- Produces:
  - `useAuth(): { session: Session | null; profile: Profile | null; loading: boolean; signOut(): Promise<void> }` from `src/context/AuthContext.tsx`
  - `Profile` type: `{ id: string; email: string; full_name: string; avatar_url: string | null; is_admin: boolean }`
  - `<RequireAuth>` and `<RequireAdmin>` wrapper components from `src/components/guards.tsx`
  - Route structure in `App.tsx` that later tasks add routes into.

- [ ] **Step 1: AuthContext**

`src/context/AuthContext.tsx`:

```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

export interface Profile {
  id: string
  email: string
  full_name: string
  avatar_url: string | null
  is_admin: boolean
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
    supabase.from('profiles').select('*').eq('id', session.user.id).single()
      .then(({ data }) => {
        setProfile(data as Profile | null)
        setLoading(false)
      })
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
```

- [ ] **Step 2: Login page**

`src/pages/Login.tsx`:

```tsx
import { supabase } from '../lib/supabase'

export default function Login() {
  const signIn = () =>
    supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    })

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center gap-8 px-6">
      <div className="text-center">
        <div className="text-5xl mb-3">🍿</div>
        <h1 className="text-2xl font-bold">SnackLabs</h1>
        <p className="text-ink-500 mt-1">The office pantry, in your pocket.</p>
      </div>
      <button
        onClick={signIn}
        className="w-full max-w-xs rounded-xl bg-ink-900 text-white py-3 font-medium active:scale-95 transition"
      >
        Continue with Google
      </button>
      <p className="text-xs text-ink-500">goabroad.com accounts only</p>
    </div>
  )
}
```

- [ ] **Step 3: Guards**

`src/components/guards.tsx`:

```tsx
import type { ReactNode } from 'react'
import { Navigate } from 'react-router'
import { useAuth } from '../context/AuthContext'

function Splash() {
  return <div className="min-h-dvh flex items-center justify-center text-ink-500">Loading…</div>
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
```

- [ ] **Step 4: Wire up routing**

`src/main.tsx`:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
import App from './App'
import { AuthProvider } from './context/AuthContext'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
```

`src/App.tsx` (placeholder pages get replaced by later tasks):

```tsx
import { Routes, Route } from 'react-router'
import Login from './pages/Login'
import { RequireAuth, RequireAdmin } from './components/guards'

const Placeholder = ({ name }: { name: string }) => (
  <div className="p-8 text-ink-500">{name} — coming soon</div>
)

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<RequireAuth><Placeholder name="Store" /></RequireAuth>} />
      <Route path="/admin/*" element={<RequireAdmin><Placeholder name="Admin" /></RequireAdmin>} />
    </Routes>
  )
}
```

- [ ] **Step 5: Verify**

Run: `npm run build` → succeeds. Run `npm run dev`, open the app: unauthenticated users land on `/login`; clicking "Continue with Google" redirects to Google. After the user signs in once, remind them to run the `is_admin` SQL from Task 2 Step 4. Verify a row exists: `select * from public.profiles;`.

---

