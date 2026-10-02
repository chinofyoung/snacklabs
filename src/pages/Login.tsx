import { useState } from 'react'
import { Link, Navigate } from 'react-router'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

export default function Login() {
  const { session } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const signIn = () =>
    supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    })

  const signInWithPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error: authErr } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    })
    if (authErr) {
      // Supabase returns the same "Invalid login credentials" for a wrong
      // password and an unknown address, which is the behaviour we want.
      setError('Incorrect email or password.')
      setBusy(false)
      return
    }
    // On success the auth listener in AuthContext sets the session and the
    // redirect below hands off to HomeRedirect, which routes to the store, the
    // admin console, or the pending screen.
    setBusy(false)
  }

  const field = 'w-full rounded-xl bg-surface-raised border border-line px-3 py-3 text-sm outline-none focus-visible:outline-2 focus-visible:outline-brand-700'

  // Unlike the Google flow (which returns to "/"), a password sign-in resolves
  // in place on /login, which no guard covers. Leave once a session exists.
  if (session) return <Navigate to="/" replace />

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-6 py-10 relative overflow-hidden bg-ink-900">
      {/* Ambient warm glow, evokes a fridge/shelf light */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 left-1/2 -translate-x-1/2 h-80 w-80 rounded-full opacity-40 blur-3xl"
        style={{ background: 'radial-gradient(circle, var(--color-brand-500), transparent 70%)' }}
      />

      <div className="relative w-full max-w-xs">
        {/* The price tag: this app's signature element — a hand-labelled shelf tag,
            complete with a punched hole, standing in for the physical pantry sign. */}
        <div className="rounded-2xl bg-logo-cream px-8 pt-8 pb-7 text-center shadow-float">
          <img src="/assets/snacklabs-logo.png" alt="SnackLabs" width={1182} height={372} className="w-56 h-auto mx-auto" />
          <p className="text-ink-500 mt-1 text-sm">The office pantry, in your pocket.</p>
        </div>

        <div className="mt-10 space-y-4">
          <form onSubmit={signInWithPassword} className="space-y-3">
            <input className={field} type="email" placeholder="Email address" value={email}
              onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
            <input className={field} type="password" placeholder="Password" value={password}
              onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
            {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
            <button type="submit" disabled={busy}
              className="w-full rounded-2xl bg-brand-600 text-white py-3.5 font-semibold shadow-card active:scale-[0.98] transition disabled:opacity-50">
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <div className="flex items-center gap-3" aria-hidden>
            <span className="h-px grow bg-white/15" />
            <span className="text-xs text-ink-400">or</span>
            <span className="h-px grow bg-white/15" />
          </div>

          <button
            onClick={signIn}
            className="w-full rounded-2xl bg-surface-raised text-ink-900 py-3.5 font-semibold shadow-card active:scale-[0.98] transition flex items-center justify-center gap-2.5"
          >
            <GoogleIcon />
            Continue with Google
          </button>
          <p className="text-xs text-center text-ink-400">
            No account?{' '}
            <Link to="/register" className="underline underline-offset-2 hover:text-white transition-colors">
              Register
            </Link>
          </p>
          <p className="text-xs text-center text-ink-400 flex items-center justify-center gap-3">
            <Link to="/privacy" className="underline underline-offset-2 hover:text-white transition-colors">
              Privacy Policy
            </Link>
            <Link to="/terms" className="underline underline-offset-2 hover:text-white transition-colors">
              Terms of Service
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.71v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.61z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.19l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.34 0-4.33-1.58-5.04-3.71H.96v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.96 10.7A5.4 5.4 0 0 1 3.68 9c0-.59.1-1.17.28-1.7V4.97H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.03z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.97L3.96 7.3C4.67 5.17 6.66 3.58 9 3.58z" />
    </svg>
  )
}
