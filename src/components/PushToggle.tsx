import { useEffect, useId, useState, type ReactNode } from 'react'
import { BellRing } from 'lucide-react'
import {
  hasPushSubscription,
  pushSupport,
  serviceWorkerReady,
  subscribeToPush,
  unsubscribeFromPush,
  type PushSupport,
} from '../lib/push'

// One explanation per state in which a switch could not work. Typed as a Record
// over every non-ready state, so a new PushSupport value is a compile error here
// rather than a silent fall-through to a control that fails.
const EXPLANATIONS: Record<Exclude<PushSupport, 'ready'>, ReactNode> = {
  // iOS and iPadOS cannot do web push from a Safari tab at any version.
  'needs-install': (
    <>
      Add SnackLabs to your Home Screen to turn on notifications. Tap the share button, then{' '}
      <b>Add to Home Screen</b>, and open it from there.
    </>
  ),
  // The Push API cannot re-prompt after a refusal; only browser settings can undo it.
  denied: <>Notifications are blocked for this site. You’ll need to allow them in your browser settings — we can’t ask again from here.</>,
  unsupported: <>This browser doesn’t support notifications. You’ll still see alerts in the app.</>,
}

// Whether the service worker, which every push call depends on, is up. 'stalled'
// means it did not become ready in time (registration failed), which would
// otherwise leave this control waiting forever.
type Worker = 'checking' | 'ready' | 'stalled'

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-3">
      <h2 className="font-display text-lg font-bold flex items-center gap-1.5">
        <BellRing className="size-5 text-brand-600" strokeWidth={2.5} aria-hidden="true" />
        Notifications
      </h2>
      {children}
    </div>
  )
}

export default function PushToggle() {
  // Computed synchronously so an iPhone never flashes a wrong message first.
  const [support, setSupport] = useState<PushSupport>(pushSupport)
  const [worker, setWorker] = useState<Worker>('checking')
  const [on, setOn] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const statusId = useId()

  useEffect(() => {
    if (support !== 'ready') return
    let cancelled = false
    // Wait for the worker before offering the switch. Without this, someone with a
    // dead worker would be shown a switch, asked for permission, and only then told
    // it cannot work. A rejection here is the worker's registration never finishing.
    serviceWorkerReady()
      .then(() => hasPushSubscription())
      .then((subscribed) => {
        if (cancelled) return
        setOn(subscribed)
        setWorker('ready')
      })
      .catch(() => {
        if (!cancelled) setWorker('stalled')
      })
    return () => {
      cancelled = true
    }
  }, [support])

  const toggle = async () => {
    setBusy(true)
    setError(null)
    try {
      if (on) {
        await unsubscribeFromPush()
        setOn(false)
      } else {
        // The permission prompt must come from this click. iOS requires a user
        // gesture, and asking on page load is how people end up denying forever.
        // subscribeToPush() calls Notification.requestPermission() before its first
        // await, so keep this call first in the handler and await nothing before it.
        await subscribeToPush()
        setOn(true)
      }
    } catch (e) {
      // A fresh denial moves us from 'ready' to 'denied'. Re-read it so the next
      // render stops offering a switch that can never work, and let that
      // explanation stand in for the generic error line.
      const next = pushSupport()
      setSupport(next)
      setError(next === 'ready' ? (e instanceof Error ? e.message : 'Could not change notification settings.') : null)
    } finally {
      setBusy(false)
    }
  }

  if (support !== 'ready') {
    return (
      <Card>
        <p className="text-sm text-ink-700">{EXPLANATIONS[support]}</p>
      </Card>
    )
  }

  if (worker === 'stalled') {
    return (
      <Card>
        <p className="text-sm text-ink-700" role="status">
          Notifications could not start on this device. Reload the page to try again.
        </p>
      </Card>
    )
  }

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <p id={statusId} className="text-sm text-ink-700">
          {on ? 'On for this device.' : 'Get told about top-up updates and anything that needs your attention, even when the app is closed.'}
        </p>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Push notifications"
          aria-describedby={statusId}
          aria-busy={busy || worker === 'checking'}
          disabled={busy || worker === 'checking'}
          onClick={toggle}
          // The off track is ink-500, not the paler tint the other switches use: that
          // tint is 1.36:1 against white, below the 3:1 WCAG asks of a control's edge.
          className={`shrink-0 w-12 h-7 rounded-full transition relative disabled:opacity-50 ${on ? 'bg-brand-600' : 'bg-ink-500'}`}
        >
          <span
            aria-hidden="true"
            className={`absolute top-0.5 size-6 rounded-full bg-white shadow transition ${on ? 'left-[calc(100%-1.625rem)]' : 'left-0.5'}`}
          />
        </button>
      </div>
      <p className="text-xs text-ink-700">Each device needs turning on separately.</p>
      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
    </Card>
  )
}
