// Service worker for web push ONLY.
//
// There is deliberately NO `fetch` handler here. Adding one turns on offline
// caching, which changes how the entire app loads and is a far larger and
// riskier change than notifications. If you are tempted to add caching, that is
// a separate piece of work with its own design.

self.addEventListener('push', (event) => {
  if (!event.data) return
  let payload
  try {
    payload = event.data.json()
  } catch {
    return
  }
  event.waitUntil(
    self.registration.showNotification(payload.title ?? 'SnackLabs', {
      body: payload.body ?? '',
      icon: '/assets/icon-192.png',
      badge: '/assets/icon-192.png',
      data: { link: payload.link ?? '/notifications' },
    }),
  )
})

// Where a notification click may take the user. `link` arrives in a push payload
// and is stored on the notification, so it is data, not something to trust: a
// value that resolves to another origin (an absolute URL, a protocol-relative
// `//host`, `javascript:`) would turn a click into an open redirect. Resolved
// against our own origin and accepted only if it stays there.
function sameOriginTarget(link) {
  const fallback = new URL('/notifications', self.location.origin).href
  try {
    const url = new URL(link, self.location.origin)
    return url.origin === self.location.origin ? url.href : fallback
  } catch {
    return fallback
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = sameOriginTarget(event.notification.data?.link ?? '/notifications')

  // Focus an open tab if there is one, rather than stacking up new windows.
  // navigate() is awaited because it rejects for a window this worker does not
  // control; left unawaited that is an unhandled rejection and the click appears
  // to do nothing. When it fails, a fresh window still gets the user to the link.
  const focusAndNavigate = async (w) => {
    try {
      await w.navigate(target)
    } catch {
      return self.clients.openWindow(target)
    }
    return w.focus()
  }

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => 'focus' in w)
      return open ? focusAndNavigate(open) : self.clients.openWindow(target)
    }),
  )
})
