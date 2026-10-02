import { supabase } from './supabase'
import { withTimeout } from './withTimeout'

export type PushSupport = 'ready' | 'denied' | 'needs-install' | 'unsupported'

function isIos(): boolean {
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) return true
  // iPadOS 13+ reports a Macintosh UA. Touch points are what separate an iPad
  // from a desktop Mac, and the distinction matters: an iPad in a tab should be
  // told to install to the Home Screen, not told its browser cannot do this.
  return /Macintosh/.test(navigator.userAgent) && (navigator.maxTouchPoints ?? 0) > 1
}

function isStandalone(): boolean {
  // iOS exposes navigator.standalone; everyone else uses the display-mode query.
  return (
    ('standalone' in navigator && (navigator as { standalone?: boolean }).standalone === true) ||
    (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches)
  )
}

/**
 * What the Settings toggle should render. Deliberately four states rather than a
 * boolean: "you cannot do this here" and "you said no and I cannot ask again"
 * need different words, and offering a button in either case produces a control
 * that silently fails.
 */
export function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported'
  // iOS has no web push in a Safari tab at any version — only from the Home Screen.
  // This must run BEFORE the capability probes below: in a plain Safari tab iOS
  // does not expose PushManager at all, so the probes would answer "unsupported"
  // and hide the one fix the user has, which is installing to the Home Screen.
  if (isIos() && !isStandalone()) return 'needs-install'
  if (!('serviceWorker' in navigator) || typeof PushManager === 'undefined') return 'unsupported'
  if (typeof Notification === 'undefined') return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  return 'ready'
}

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return
  navigator.serviceWorker.register('/sw.js').catch((e) => {
    console.error('service worker registration failed', e)
  })
}

// How long to wait for the service worker before deciding it is not coming.
// Generous for a first install on a slow phone; far shorter than "forever".
const SERVICE_WORKER_TIMEOUT_MS = 10_000

/**
 * `navigator.serviceWorker.ready` resolves only once a worker is ACTIVE. If
 * registration failed (sw.js unreachable or broken) it never settles at all, so a
 * bare `await` hangs the caller indefinitely instead of rejecting. Everything in
 * this module that needs the worker goes through here so a dead worker surfaces
 * as an error the UI can show.
 *
 * Deliberately not applied to the permission prompt: that wait is the user
 * deciding, and cutting it short would report a failure while the prompt is
 * still open.
 */
export function serviceWorkerReady(timeoutMs = SERVICE_WORKER_TIMEOUT_MS): Promise<ServiceWorkerRegistration> {
  return withTimeout(
    navigator.serviceWorker.ready,
    timeoutMs,
    'Notifications could not start on this device. Reload the page and try again.',
  )
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)))
}

export async function subscribeToPush(): Promise<void> {
  const key = import.meta.env.VITE_VAPID_PUBLIC_KEY
  if (!key) throw new Error('Push is not configured.')

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('Notification permission was not granted.')

  const registration = await serviceWorkerReady()
  const sub = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key),
  })

  const json = sub.toJSON()

  // A push endpoint identifies a browser, not a person. On a shared office phone
  // the endpoint may already belong to someone else, and a plain insert/upsert
  // would hit RLS: this user gets no push while the previous owner keeps getting
  // theirs on a device this user is holding. The RPC hands the endpoint to
  // whoever is signed in now. It uses auth.uid(), so no user id is sent.
  const { error } = await supabase.rpc('claim_push_subscription', {
    p_endpoint: sub.endpoint,
    p_p256dh: json.keys?.p256dh ?? '',
    p_auth: json.keys?.auth ?? '',
    p_user_agent: navigator.userAgent.slice(0, 255),
  })
  if (error) throw new Error(error.message)
}

export async function unsubscribeFromPush(): Promise<void> {
  const registration = await serviceWorkerReady()
  const sub = await registration.pushManager.getSubscription()
  if (!sub) return
  const { endpoint } = sub
  // The browser goes first. Unsubscribing is local: no network and no session, so
  // it lands even offline or mid sign-out, and from then on the endpoint is dead
  // (the push service answers 404/410 and send-push prunes the row). The row
  // DELETE is the part that can stall, and a stalled DELETE ahead of this would
  // leave both the row and the subscription behind, which is exactly the
  // lock-screen leak that signing out is meant to prevent.
  await sub.unsubscribe()
  await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint)
}

export async function hasPushSubscription(): Promise<boolean> {
  if (pushSupport() !== 'ready') return false
  if (Notification.permission !== 'granted') return false
  const registration = await serviceWorkerReady()
  return (await registration.pushManager.getSubscription()) !== null
}
