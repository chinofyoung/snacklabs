import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { withTimeout } from './withTimeout'

describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves with the value when the promise settles first', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'too slow')).resolves.toBe('ok')
  })

  it('passes the original rejection through untouched', async () => {
    const boom = new Error('boom')
    await expect(withTimeout(Promise.reject(boom), 1000, 'too slow')).rejects.toBe(boom)
  })

  it('rejects with the given message when the promise never settles', async () => {
    const result = withTimeout(new Promise<never>(() => {}), 1000, 'too slow')
    const assertion = expect(result).rejects.toThrow('too slow')
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
  })

  it('does not reject before the deadline', async () => {
    let settled = false
    withTimeout(new Promise<never>(() => {}), 1000, 'too slow').catch(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(999)
    expect(settled).toBe(false)
  })

  it('leaves no timer pending after a fast success', async () => {
    await withTimeout(Promise.resolve('ok'), 1000, 'too slow')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves no timer pending after a fast rejection', async () => {
    await withTimeout(Promise.reject(new Error('boom')), 1000, 'too slow').catch(() => {})
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores a late resolution after it has already timed out', async () => {
    let resolveLate!: (v: string) => void
    const late = new Promise<string>((r) => {
      resolveLate = r
    })
    const result = withTimeout(late, 1000, 'too slow')
    const assertion = expect(result).rejects.toThrow('too slow')
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
    resolveLate('finally')
    await expect(result).rejects.toThrow('too slow')
  })
})
