import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { signOutAndReleasePush } from './signOut'

const mocks = vi.hoisted(() => ({
  authSignOut: vi.fn(),
  unsubscribeFromPush: vi.fn(),
}))
vi.mock('./supabase', () => ({ supabase: { auth: { signOut: mocks.authSignOut } } }))
vi.mock('./push', () => ({ unsubscribeFromPush: mocks.unsubscribeFromPush }))

describe('signOutAndReleasePush', () => {
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // vitest runs in Node here (no jsdom), so the one browser capability this
    // module probes is stubbed in.
    vi.stubGlobal('navigator', { serviceWorker: {} })
    mocks.authSignOut.mockReset().mockResolvedValue({ error: null })
    mocks.unsubscribeFromPush.mockReset().mockResolvedValue(undefined)
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    consoleError.mockRestore()
  })

  it('removes the push subscription BEFORE the session ends', async () => {
    // The push_subscriptions DELETE is an RLS-protected write that needs the
    // session. Run after sign-out it would be refused, leaving the previous
    // account's row delivering to a device the next person is holding.
    const order: string[] = []
    mocks.unsubscribeFromPush.mockImplementation(async () => {
      order.push('unsubscribe')
    })
    mocks.authSignOut.mockImplementation(async () => {
      order.push('signOut')
      return { error: null }
    })
    await signOutAndReleasePush()
    expect(order).toEqual(['unsubscribe', 'signOut'])
  })

  it('still signs out when unsubscribing throws', async () => {
    // Offline, no active worker, a failed teardown: none may trap the user signed in.
    mocks.unsubscribeFromPush.mockRejectedValue(new Error('offline'))
    await expect(signOutAndReleasePush()).resolves.toBeUndefined()
    expect(mocks.authSignOut).toHaveBeenCalledOnce()
    expect(consoleError).toHaveBeenCalledOnce()
  })

  it('still signs out when unsubscribing never settles', async () => {
    // navigator.serviceWorker.ready never settles if registration failed, and the
    // network half of the teardown can stall. Sign-out waits a bounded time, then
    // goes ahead.
    vi.useFakeTimers()
    mocks.unsubscribeFromPush.mockReturnValue(new Promise<void>(() => {}))
    const done = signOutAndReleasePush()
    await vi.advanceTimersByTimeAsync(4_999)
    expect(mocks.authSignOut).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(done).resolves.toBeUndefined()
    expect(mocks.authSignOut).toHaveBeenCalledOnce()
    expect(consoleError).toHaveBeenCalledOnce()
  })

  it('does not wait on the timeout when unsubscribing succeeds', async () => {
    vi.useFakeTimers()
    await signOutAndReleasePush()
    expect(mocks.authSignOut).toHaveBeenCalledOnce()
    // withTimeout clears its timer once the teardown settles.
    expect(vi.getTimerCount()).toBe(0)
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('skips the teardown quietly when the browser has no service workers', async () => {
    vi.stubGlobal('navigator', {})
    await signOutAndReleasePush()
    expect(mocks.unsubscribeFromPush).not.toHaveBeenCalled()
    expect(mocks.authSignOut).toHaveBeenCalledOnce()
    expect(consoleError).not.toHaveBeenCalled()
  })
})
