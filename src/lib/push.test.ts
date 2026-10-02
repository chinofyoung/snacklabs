import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { hasPushSubscription, pushSupport, subscribeToPush, unsubscribeFromPush } from './push'

const supabaseMock = vi.hoisted(() => ({
  rpc: vi.fn(),
  deleteEq: vi.fn(),
}))
// The service-worker tests below drive the real subscribe/unsubscribe paths; the
// network half of those is out of scope, so it is answered here.
vi.mock('./supabase', () => ({
  supabase: {
    rpc: supabaseMock.rpc,
    from: () => ({ delete: () => ({ eq: supabaseMock.deleteEq }) }),
  },
}))

// vitest runs in Node here (no jsdom), so none of the browser globals that
// pushSupport() probes exist. Every test builds its own browser from a fully
// capable baseline and overrides only the one thing it is about. That matters:
// if a case left `window` or `navigator.serviceWorker` unset, pushSupport()
// would answer 'unsupported' for the wrong reason and the case would pass (or
// fail) without exercising the branch it names.
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120'
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
// iPadOS 13+ Safari sends this desktop-class UA; only maxTouchPoints gives it away.
const IPADOS_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'

interface FakeBrowser {
  userAgent: string
  /** 0 on a desktop Mac, 5 on an iPad; the default keeps every desktop case as it was. */
  maxTouchPoints: number
  hasWindow: boolean
  hasServiceWorker: boolean
  hasPushManager: boolean
  notification: NotificationPermission | 'absent'
  displayModeStandalone: boolean
  /** iOS's legacy navigator.standalone; undefined means the property is absent. */
  navigatorStandalone?: boolean
}

function stubBrowser(overrides: Partial<FakeBrowser> = {}) {
  const b: FakeBrowser = {
    userAgent: CHROME_UA,
    maxTouchPoints: 0,
    hasWindow: true,
    hasServiceWorker: true,
    hasPushManager: true,
    notification: 'default',
    displayModeStandalone: false,
    ...overrides,
  }
  vi.stubGlobal('window', b.hasWindow ? {} : undefined)
  vi.stubGlobal('navigator', {
    userAgent: b.userAgent,
    maxTouchPoints: b.maxTouchPoints,
    ...(b.hasServiceWorker ? { serviceWorker: {} } : {}),
    ...(b.navigatorStandalone === undefined ? {} : { standalone: b.navigatorStandalone }),
  })
  vi.stubGlobal('PushManager', b.hasPushManager ? class {} : undefined)
  vi.stubGlobal('Notification', b.notification === 'absent' ? undefined : { permission: b.notification })
  // Answers only the display-mode query pushSupport() asks, so a typo in the
  // query string cannot pass by accident.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(display-mode: standalone)' && b.displayModeStandalone,
  }))
}

describe('pushSupport', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports unsupported when PushManager is absent', () => {
    stubBrowser({ hasPushManager: false })
    expect(pushSupport()).toBe('unsupported')
  })

  it('reports needs-install on an iPhone that is not standalone', () => {
    // iOS has no web push in a Safari tab at ANY version. A toggle rendered here
    // would simply fail, so the UI must ask for a Home Screen install instead.
    stubBrowser({ userAgent: IPHONE_UA, displayModeStandalone: false })
    expect(pushSupport()).toBe('needs-install')
  })

  it('reports ready on an installed iPhone', () => {
    stubBrowser({ userAgent: IPHONE_UA, displayModeStandalone: true })
    expect(pushSupport()).toBe('ready')
  })

  it('reports denied when permission was refused', () => {
    // The Push API cannot re-prompt after a denial, so the UI must explain
    // rather than offer a button that can never work.
    stubBrowser({ notification: 'denied' })
    expect(pushSupport()).toBe('denied')
  })

  it('reports ready on desktop Chrome with permission undecided', () => {
    stubBrowser({ notification: 'default' })
    expect(pushSupport()).toBe('ready')
  })

  it('reports ready when permission is already granted', () => {
    stubBrowser({ notification: 'granted' })
    expect(pushSupport()).toBe('ready')
  })

  describe('each unsupported cause on its own', () => {
    it('reports unsupported when there is no service worker', () => {
      stubBrowser({ hasServiceWorker: false })
      expect(pushSupport()).toBe('unsupported')
    })

    it('reports unsupported when the Notification API is absent', () => {
      stubBrowser({ notification: 'absent' })
      expect(pushSupport()).toBe('unsupported')
    })

    it('reports unsupported when there is no window at all', () => {
      stubBrowser({ hasWindow: false })
      expect(pushSupport()).toBe('unsupported')
    })
  })

  describe('iOS', () => {
    // iPod touch UAs say "iPhone OS", so the iPhone alternative already covers them.
    it.each([
      ['iPhone', IPHONE_UA],
      ['iPad', IPAD_UA],
    ])('reports needs-install on %s in a browser tab', (_device, userAgent) => {
      stubBrowser({ userAgent })
      expect(pushSupport()).toBe('needs-install')
    })

    it('reports needs-install, not unsupported, when Safari hides PushManager in a tab', () => {
      // iOS only exposes PushManager to Home Screen web apps. In a plain tab it is
      // simply missing, so if the capability probes ran first the user would be
      // told "unsupported" and never learn that installing is the fix.
      stubBrowser({ userAgent: IPHONE_UA, hasPushManager: false })
      expect(pushSupport()).toBe('needs-install')
    })

    it('treats the legacy navigator.standalone flag as installed', () => {
      // display-mode is false here, so only navigator.standalone can say "installed".
      stubBrowser({ userAgent: IPHONE_UA, navigatorStandalone: true, displayModeStandalone: false })
      expect(pushSupport()).toBe('ready')
    })

    it('does not treat navigator.standalone === false as installed', () => {
      stubBrowser({ userAgent: IPHONE_UA, navigatorStandalone: false, displayModeStandalone: false })
      expect(pushSupport()).toBe('needs-install')
    })

    it('still honours a refused permission once installed', () => {
      stubBrowser({ userAgent: IPHONE_UA, displayModeStandalone: true, notification: 'denied' })
      expect(pushSupport()).toBe('denied')
    })
  })

  describe('iPadOS (Macintosh user agent)', () => {
    it('reports needs-install on an iPad in a browser tab', () => {
      // The iPad can push once installed, so it must be told how, not told "unsupported".
      stubBrowser({ userAgent: IPADOS_UA, maxTouchPoints: 5, displayModeStandalone: false })
      expect(pushSupport()).toBe('needs-install')
    })

    it('reports needs-install on an iPad even though Safari hides PushManager in a tab', () => {
      stubBrowser({ userAgent: IPADOS_UA, maxTouchPoints: 5, hasPushManager: false })
      expect(pushSupport()).toBe('needs-install')
    })

    it('reports ready on a desktop Mac with no touch points', () => {
      // Same UA as the iPad; maxTouchPoints is the only thing that tells them apart.
      stubBrowser({ userAgent: IPADOS_UA, maxTouchPoints: 0 })
      expect(pushSupport()).toBe('ready')
    })

    it('reports ready on an iPad installed to the Home Screen', () => {
      stubBrowser({ userAgent: IPADOS_UA, maxTouchPoints: 5, displayModeStandalone: true })
      expect(pushSupport()).toBe('ready')
    })

    it('does not mistake a touch-screen Android phone for an iPad', () => {
      // Android also reports maxTouchPoints 5. Without the Macintosh UA test, every
      // Android phone would be told to install to a Home Screen it does not need to.
      stubBrowser({ userAgent: ANDROID_UA, maxTouchPoints: 5 })
      expect(pushSupport()).toBe('ready')
    })

    it('treats a single touch point as a desktop Mac, not an iPad', () => {
      // iPadOS reports 5; the > 1 threshold keeps a lone-pointer device out.
      stubBrowser({ userAgent: IPADOS_UA, maxTouchPoints: 1 })
      expect(pushSupport()).toBe('ready')
    })
  })

  describe('non-iOS standalone', () => {
    it('is unaffected by display-mode', () => {
      // An installed desktop/Android PWA is just a browser that can push.
      stubBrowser({ displayModeStandalone: true })
      expect(pushSupport()).toBe('ready')
    })
  })
})

describe('a service worker that never becomes ready', () => {
  // navigator.serviceWorker.ready never settles when registration failed. Without
  // a deadline every function that awaits it hangs, and a Settings toggle sits in
  // its busy state forever. These pin that each one rejects instead.
  const STALLED = 'Notifications could not start on this device. Reload the page and try again.'
  const NEVER = new Promise<never>(() => {})

  function fakeRegistration({ alreadySubscribed = false } = {}) {
    const sub = {
      endpoint: 'https://push.example/abc',
      toJSON: () => ({ keys: { p256dh: 'p', auth: 'a' } }),
      unsubscribe: vi.fn().mockResolvedValue(true),
    }
    return {
      sub,
      registration: {
        pushManager: {
          subscribe: vi.fn().mockResolvedValue(sub),
          getSubscription: vi.fn().mockResolvedValue(alreadySubscribed ? sub : null),
        },
      },
    }
  }

  function stubPushBrowser(opts: {
    ready: Promise<unknown>
    permission?: NotificationPermission
    requestPermission?: () => Promise<NotificationPermission>
  }) {
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', { userAgent: CHROME_UA, maxTouchPoints: 0, serviceWorker: { ready: opts.ready } })
    vi.stubGlobal('PushManager', class {})
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    vi.stubGlobal('Notification', {
      permission: opts.permission ?? 'granted',
      requestPermission: opts.requestPermission ?? (() => Promise.resolve('granted' as const)),
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubEnv('VITE_VAPID_PUBLIC_KEY', 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U')
    supabaseMock.rpc.mockReset().mockResolvedValue({ error: null })
    supabaseMock.deleteEq.mockReset().mockResolvedValue({ error: null })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('subscribeToPush rejects instead of hanging once permission is granted', async () => {
    stubPushBrowser({ ready: NEVER })
    const result = subscribeToPush()
    const assertion = expect(result).rejects.toThrow(STALLED)
    await vi.advanceTimersByTimeAsync(10_000)
    await assertion
    expect(supabaseMock.rpc).not.toHaveBeenCalled()
  })

  it('does not run the clock while the user is still deciding on the permission prompt', async () => {
    // The permission wait is a person reading a prompt, not a hang. A deadline
    // there would report a failure with the prompt still open, then the
    // subscription would complete in the background behind an error message.
    const { registration } = fakeRegistration()
    stubPushBrowser({
      ready: Promise.resolve(registration),
      permission: 'default',
      requestPermission: () =>
        new Promise((resolve) => setTimeout(() => resolve('granted'), 60_000)),
    })
    let failure: unknown = null
    const result = subscribeToPush().catch((e: unknown) => {
      failure = e
    })
    await vi.advanceTimersByTimeAsync(59_000)
    expect(failure).toBeNull()
    await vi.advanceTimersByTimeAsync(1_000)
    await result
    expect(failure).toBeNull()
    expect(supabaseMock.rpc).toHaveBeenCalledOnce()
  })

  it('hasPushSubscription rejects instead of hanging when permission is already granted', async () => {
    stubPushBrowser({ ready: NEVER, permission: 'granted' })
    const result = hasPushSubscription()
    const assertion = expect(result).rejects.toThrow(STALLED)
    await vi.advanceTimersByTimeAsync(10_000)
    await assertion
  })

  it('hasPushSubscription answers false at once, without touching the worker, before permission is granted', async () => {
    stubPushBrowser({ ready: NEVER, permission: 'default' })
    await expect(hasPushSubscription()).resolves.toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('unsubscribeFromPush rejects instead of hanging', async () => {
    stubPushBrowser({ ready: NEVER })
    const result = unsubscribeFromPush()
    const assertion = expect(result).rejects.toThrow(STALLED)
    await vi.advanceTimersByTimeAsync(10_000)
    await assertion
    expect(supabaseMock.deleteEq).not.toHaveBeenCalled()
  })

  describe('unsubscribeFromPush ordering', () => {
    // The row DELETE needs the network and a session; the browser unsubscribe needs
    // neither. Doing the local one first means a slow or failing DELETE can never
    // leave the device still subscribed (the leak sign-out exists to prevent).
    it('unsubscribes the browser BEFORE deleting the row', async () => {
      const { registration, sub } = fakeRegistration({ alreadySubscribed: true })
      stubPushBrowser({ ready: Promise.resolve(registration) })
      const order: string[] = []
      sub.unsubscribe.mockImplementation(async () => {
        order.push('unsubscribe')
        return true
      })
      supabaseMock.deleteEq.mockImplementation(async () => {
        order.push('delete')
        return { error: null }
      })
      await unsubscribeFromPush()
      expect(order).toEqual(['unsubscribe', 'delete'])
    })

    it('has already unsubscribed the browser while the row DELETE is still stalled', async () => {
      const { registration, sub } = fakeRegistration({ alreadySubscribed: true })
      stubPushBrowser({ ready: Promise.resolve(registration) })
      supabaseMock.deleteEq.mockReturnValue(new Promise(() => {}))
      void unsubscribeFromPush()
      await vi.advanceTimersByTimeAsync(0)
      expect(supabaseMock.deleteEq).toHaveBeenCalledWith('endpoint', sub.endpoint)
      expect(sub.unsubscribe).toHaveBeenCalledOnce()
    })

    it('does nothing, quietly, when there is no subscription', async () => {
      const { registration, sub } = fakeRegistration({ alreadySubscribed: false })
      stubPushBrowser({ ready: Promise.resolve(registration) })
      await expect(unsubscribeFromPush()).resolves.toBeUndefined()
      expect(sub.unsubscribe).not.toHaveBeenCalled()
      expect(supabaseMock.deleteEq).not.toHaveBeenCalled()
    })
  })

  it('still works at full speed when the worker is ready', async () => {
    const { registration, sub } = fakeRegistration({ alreadySubscribed: true })
    stubPushBrowser({ ready: Promise.resolve(registration) })
    await expect(hasPushSubscription()).resolves.toBe(true)
    await unsubscribeFromPush()
    expect(supabaseMock.deleteEq).toHaveBeenCalledWith('endpoint', sub.endpoint)
    expect(sub.unsubscribe).toHaveBeenCalledOnce()
  })
})
