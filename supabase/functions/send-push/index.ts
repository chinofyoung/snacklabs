import { createClient } from 'npm:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'
import { timingSafeEqual } from 'node:crypto'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  // The gateway's JWT check is not enough: the public anon key passes it, and that
  // key ships in the client bundle by design. This function is only ever called by
  // the database (pg_net, carrying the service-role key from the vault), so it
  // insists on that key. Without this, anyone could POST a known notification id
  // and replay its push.
  if (!(await isServiceRole(req))) return json({ error: 'unauthorized' }, 401)

  const { notification_id } = await req.json().catch(() => ({}))
  if (!notification_id) return json({ error: 'notification_id required' }, 400)

  const publicKey = Deno.env.get('VAPID_PUBLIC_KEY')
  const privateKey = Deno.env.get('VAPID_PRIVATE_KEY')
  const subject = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com'
  if (!publicKey || !privateKey) {
    console.error('send-push: VAPID keys are not configured')
    return json({ error: 'not configured' }, 500)
  }
  webpush.setVapidDetails(subject, publicKey, privateKey)

  // Service role: this reads another user's subscriptions on their behalf, which
  // RLS correctly forbids to everyone else.
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )

  const { data: notification, error: nErr } = await admin
    .from('notifications')
    .select('id, user_id, title, body, link')
    .eq('id', notification_id)
    .single()

  if (nErr || !notification) {
    console.error('send-push: notification not found', notification_id, nErr?.message)
    return json({ error: 'not found' }, 404)
  }

  const { data: subs, error: sErr } = await admin
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('user_id', notification.user_id)

  if (sErr) {
    console.error('send-push: could not load subscriptions', sErr.message)
    return json({ error: 'subscription lookup failed' }, 500)
  }
  if (!subs?.length) return json({ ok: true, sent: 0 }, 200)

  const payload = JSON.stringify({
    title: notification.title,
    body: notification.body,
    link: notification.link || '/notifications',
  })

  let sent = 0
  const dead: string[] = []

  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
      )
      sent++
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode
      // 404/410 mean the browser is gone for good — the icon was deleted, the
      // profile wiped, or the subscription expired. Anything else may be
      // transient, so the row is kept.
      if (status === 404 || status === 410) dead.push(s.id)
      else console.error('send-push: send failed', status, (e as Error).message)
    }
  }

  if (dead.length) {
    await admin.from('push_subscriptions').delete().in('id', dead)
  }

  return json({ ok: true, sent, pruned: dead.length }, 200)
})

// Constant-time bearer check. Both sides are hashed first so the buffers are
// always the same length (timingSafeEqual throws on a mismatch, and comparing
// raw lengths would leak the key's length). Nothing here logs the token.
async function isServiceRole(req: Request): Promise<boolean> {
  const expected = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const presented = /^Bearer\s+(\S+)$/i.exec(req.headers.get('Authorization') ?? '')?.[1]
  if (!expected || !presented) return false

  const sha256 = async (value: string) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  return timingSafeEqual(await sha256(presented), await sha256(expected))
}

function json(payload: unknown, status: number) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}
