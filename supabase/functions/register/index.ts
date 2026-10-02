import { createClient } from 'npm:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// One message for every outcome that could distinguish an allowed domain from a
// disallowed one. "Domain not allowed" and "already registered" MUST read
// identically: a distinct second message would let anyone probe addresses and
// learn, from the difference, which domains are on the list.
const GENERIC = "This email address can't be used to register. Check with your administrator."

// Matches minimum_password_length in supabase/config.toml.
const MIN_PASSWORD = 6

// Shape only: one @, something on each side, a dot in the domain, no spaces.
// Independent of the allowlist, so rejecting here discloses nothing about it.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  const body = await req.json().catch(() => null)
  if (!body) return json({ error: 'invalid request' }, 400)

  const firstName = String(body.first_name ?? '').trim()
  const lastName = String(body.last_name ?? '').trim()
  const email = String(body.email ?? '').trim().toLowerCase()
  const password = String(body.password ?? '')

  // Shape errors are reported precisely: they say nothing about the domain list.
  if (!firstName) return json({ error: 'First name is required.' }, 400)
  if (!lastName) return json({ error: 'Last name is required.' }, 400)
  if (!email) return json({ error: 'Email is required.' }, 400)
  if (!EMAIL_SHAPE.test(email)) return json({ error: 'Enter a valid email address.' }, 400)
  if (password.length < MIN_PASSWORD) {
    return json({ error: `Password must be at least ${MIN_PASSWORD} characters.` }, 400)
  }

  // Service role: the domain list is admin-only by RLS, and deliberately
  // unreadable by the browser. The check can only happen here.
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )

  const { data: allowed, error: checkErr } = await admin.rpc('is_email_domain_allowed', {
    p_email: email,
  })

  // A failed check is an outage, not a verdict. Returning GENERIC here would
  // tell a legitimate user they are ineligible because the database hiccuped.
  if (checkErr) {
    console.error('register: domain check failed', checkErr)
    return json({ error: 'Something went wrong. Please try again.' }, 500)
  }

  if (!allowed) {
    console.warn('register: refused ineligible domain for', email)
    return json({ error: GENERIC }, 403)
  }

  // email_confirm: true marks the address confirmed without sending mail.
  // Admin confirmation is the gate, and no SMTP provider is configured.
  const { error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { first_name: firstName, last_name: lastName },
  })

  if (createErr) {
    // Covers "already registered" and the trigger's own domain refusal. Both
    // collapse into GENERIC on purpose; the real reason goes to the logs only.
    console.warn('register: createUser failed for', email, createErr.message)
    return json({ error: GENERIC }, 403)
  }

  return json({ ok: true }, 200)
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}
