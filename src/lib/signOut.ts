import { supabase } from './supabase'
import { unsubscribeFromPush } from './push'
import { withTimeout } from './withTimeout'

// A push subscription identifies a BROWSER, not a person. Signing out without
// removing it leaves the previous account's notifications ("Your top-up of 500.00
// has been added") arriving on the lock screen of whoever picks the device up
// next, which on a shared office phone is the next person to sign in. So teardown
// has to happen as part of signing out, not as something the next person must
// know to do in Settings.
//
// Bounded rather than awaited indefinitely: a service worker that never became
// active makes `navigator.serviceWorker.ready` hang, and signing out must not wait
// on that. Generous for a slow phone doing one DELETE, far short of "forever".
const PUSH_TEARDOWN_TIMEOUT_MS = 5_000

async function releasePushSubscription(): Promise<void> {
  // No service worker API (e.g. an insecure origin): there is nothing to release,
  // and this is not worth an error in the console on every sign-out.
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  try {
    await withTimeout(
      unsubscribeFromPush(),
      PUSH_TEARDOWN_TIMEOUT_MS,
      'Timed out removing this device from push notifications.',
    )
  } catch (e) {
    // Best-effort by design. Offline, a dead worker or a failed DELETE must never
    // trap someone signed in, so the failure is logged and swallowed.
    console.error('could not remove push subscription before sign-out', e)
  }
}

/**
 * Signs out, first removing this browser's push subscription.
 *
 * The order matters: the `push_subscriptions` DELETE is an RLS-protected write
 * that needs the session, so it must run while the caller is still authenticated.
 * `supabase.auth.signOut()` runs regardless of how the teardown went.
 */
export async function signOutAndReleasePush(): Promise<void> {
  await releasePushSubscription()
  await supabase.auth.signOut()
}
