import { useState } from 'react'
import { Link, Navigate } from 'react-router'
import { FunctionsHttpError } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

// Mirrors minimum_password_length in supabase/config.toml and the register
// Edge Function, which enforces it again server-side.
const MIN_PASSWORD = 6

const GENERIC_FAILURE = 'Something went wrong. Please try again.'

// The only statuses whose body is a message written for the user: 400 for a
// malformed form, 403 for the deliberately generic eligibility refusal. Every
// other status (5xx outage, relay failure, gateway 401/404/429, ...) shows
// GENERIC_FAILURE so an outage can never read as "you are not eligible".
const USER_FACING_STATUSES = new Set([400, 403])

async function failureMessage(err: unknown): Promise<string> {
  // FunctionsFetchError (network down) and FunctionsRelayError land here.
  if (!(err instanceof FunctionsHttpError)) return GENERIC_FAILURE
  const res = err.context
  if (!(res instanceof Response) || !USER_FACING_STATUSES.has(res.status)) return GENERIC_FAILURE
  try {
    const body: unknown = await res.json()
    const message = (body as { error?: unknown } | null)?.error
    if (typeof message === 'string' && message) return message
  } catch { /* unreadable body: fall through to the generic message */ }
  return GENERIC_FAILURE
}

export default function Register() {
  const { session } = useAuth()
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (!firstName.trim() || !lastName.trim()) {
      setError('First and last name are required.')
      return
    }
    if (password.length < MIN_PASSWORD) {
      setError(`Password must be at least ${MIN_PASSWORD} characters.`)
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }

    setBusy(true)
    try {
      // Goes through the Edge Function, never supabase.auth.signUp: the domain
      // list is admin-only by RLS and cannot be checked from the browser. There
      // is deliberately no client-side domain check for the same reason.
      const { data, error: fnErr } = await supabase.functions.invoke('register', {
        body: {
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          email: email.trim().toLowerCase(),
          password,
        },
      })

      if (fnErr) {
        setError(await failureMessage(fnErr))
        return
      }
      // Only the function's own success shape counts as registered.
      if ((data as { ok?: unknown } | null)?.ok !== true) {
        setError(GENERIC_FAILURE)
        return
      }
      setDone(true)
    } catch {
      setError(GENERIC_FAILURE)
    } finally {
      setBusy(false)
    }
  }

  // Same shape as /login: no guard covers this route, so leave once a session
  // exists rather than showing a signed-in user the registration form.
  if (session) return <Navigate to="/" replace />

  if (done) {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center gap-4 px-6 text-center bg-ink-900">
        <div className="rounded-2xl bg-logo-cream px-8 py-7 max-w-xs space-y-2">
          <h1 className="font-display text-xl font-bold text-ink-900">Registration received</h1>
          <p className="text-sm text-ink-500">
            An administrator needs to confirm your account before you can sign in.
          </p>
          <Link to="/login" className="block pt-2 text-sm font-medium text-brand-700 underline underline-offset-2">
            Back to sign in
          </Link>
        </div>
      </div>
    )
  }

  const field = 'w-full rounded-xl bg-surface-raised border border-line px-3 py-3 text-sm outline-none focus-visible:outline-2 focus-visible:outline-brand-700'

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-6 py-10 bg-ink-900">
      <div className="w-full max-w-xs">
        <div className="rounded-2xl bg-logo-cream px-8 pt-8 pb-7 text-center shadow-float">
          <img src="/assets/snacklabs-logo.png" alt="SnackLabs" width={1182} height={372} className="w-56 h-auto mx-auto" />
          <p className="text-ink-500 mt-1 text-sm">Create your account.</p>
        </div>

        <form onSubmit={submit} className="mt-8 space-y-3">
          <div className="flex gap-2">
            <input className={field} placeholder="First name" value={firstName}
              onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" required />
            <input className={field} placeholder="Last name" value={lastName}
              onChange={(e) => setLastName(e.target.value)} autoComplete="family-name" required />
          </div>
          <input className={field} type="email" placeholder="Email address" value={email}
            onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
          <input className={field} type="password" placeholder="Password" value={password}
            onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
          <input className={field} type="password" placeholder="Confirm password" value={confirm}
            onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />

          {error && <p className="text-sm text-red-400" role="alert">{error}</p>}

          <button type="submit" disabled={busy}
            className="w-full rounded-2xl bg-brand-600 text-white py-3.5 font-semibold shadow-card active:scale-[0.98] transition disabled:opacity-50">
            {busy ? 'Creating account…' : 'Create account'}
          </button>
        </form>

        <p className="text-xs text-center text-ink-400 mt-5">
          Already have an account?{' '}
          <Link to="/login" className="underline underline-offset-2 hover:text-white transition-colors">Sign in</Link>
        </p>
      </div>
    </div>
  )
}
