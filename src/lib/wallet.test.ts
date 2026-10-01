import { describe, it, expect } from 'vitest'
import {
  TOPUP_MAX, canAfford, parseTopupAmount, rowSign, entryLabel, mergeHistory,
  isInsufficientBalance, describePayError,
} from './wallet'
import type { WalletEntry, TopupRequest } from '../types'

const entry = (over: Partial<WalletEntry>): WalletEntry => ({
  id: 'e1', user_id: 'u1', amount: 100, kind: 'topup',
  order_id: null, topup_id: null, note: '', created_at: '2026-10-01T00:00:00Z',
  ...over,
})

const request = (over: Partial<TopupRequest>): TopupRequest => ({
  id: 'r1', user_id: 'u1', amount: 100, payment_method_id: null,
  proof_path: 'u1/p.jpg', status: 'pending', reviewed_by: null,
  reviewed_at: null, reject_reason: '', created_at: '2026-10-01T00:00:00Z',
  ...over,
})

describe('canAfford', () => {
  it('allows an exactly-equal balance', () => {
    expect(canAfford(60, 60)).toBe(true)
  })
  it('rejects one centavo short', () => {
    expect(canAfford(59.99, 60)).toBe(false)
  })
  it('rejects a zero balance against any total', () => {
    expect(canAfford(0, 0.01)).toBe(false)
  })
  it('allows a float-summed total that equals the balance', () => {
    expect(canAfford(3.3, 1.1 * 3)).toBe(true)
  })
})

describe('parseTopupAmount', () => {
  it('accepts a plain amount', () => {
    expect(parseTopupAmount('500')).toEqual({ ok: true, value: 500 })
  })
  it('accepts two decimals', () => {
    expect(parseTopupAmount('99.50')).toEqual({ ok: true, value: 99.5 })
  })
  it('rejects more than two decimals rather than silently rounding', () => {
    expect(parseTopupAmount('100.555').ok).toBe(false)
  })
  it('trims surrounding whitespace', () => {
    expect(parseTopupAmount('  250  ')).toEqual({ ok: true, value: 250 })
  })
  it('rejects exponent notation', () => {
    expect(parseTopupAmount('1e3').ok).toBe(false)
  })
  it('rejects zero and negatives', () => {
    expect(parseTopupAmount('0').ok).toBe(false)
    expect(parseTopupAmount('-5').ok).toBe(false)
  })
  it('rejects empty and non-numeric input', () => {
    expect(parseTopupAmount('').ok).toBe(false)
    expect(parseTopupAmount('abc').ok).toBe(false)
  })
  it('accepts a single decimal place', () => {
    expect(parseTopupAmount('99.5')).toEqual({ ok: true, value: 99.5 })
  })
  it('rejects a trailing dot', () => {
    expect(parseTopupAmount('5.').ok).toBe(false)
  })
  it('rejects a leading dot', () => {
    expect(parseTopupAmount('.5').ok).toBe(false)
  })
  it('rejects thousands separators', () => {
    expect(parseTopupAmount('1,000').ok).toBe(false)
  })
  it('rejects above the cap but accepts the cap itself', () => {
    expect(parseTopupAmount(String(TOPUP_MAX)).ok).toBe(true)
    expect(parseTopupAmount(String(TOPUP_MAX + 1)).ok).toBe(false)
  })
  it('states the cap as pesos, not a bare number', () => {
    const result = parseTopupAmount(String(TOPUP_MAX + 1))
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining('₱10,000.00'),
    })
  })
})

describe('rowSign', () => {
  it('gives a rejected row no sign, since no money moved', () => {
    expect(rowSign({ kind: 'rejected', amount: 100 })).toBe('')
  })
  it('gives a pending row a prospective plus', () => {
    expect(rowSign({ kind: 'pending', amount: 100 })).toBe('+')
  })
  it('signs a ledger debit with a minus', () => {
    expect(rowSign({ kind: 'purchase', amount: -45 })).toBe('−')
  })
  it('signs a ledger credit with a plus', () => {
    expect(rowSign({ kind: 'topup', amount: 500 })).toBe('+')
    expect(rowSign({ kind: 'refund', amount: 45 })).toBe('+')
  })
})

describe('entryLabel', () => {
  it('prefers the stored note, falling back to the kind', () => {
    expect(entryLabel(entry({ note: 'Order #a3f2', kind: 'purchase' }))).toBe('Order #a3f2')
    expect(entryLabel(entry({ note: '', kind: 'refund' }))).toBe('Refund')
  })
  it('falls back to the kind label for each kind', () => {
    expect(entryLabel(entry({ note: '', kind: 'topup' }))).toBe('Top-up approved')
    expect(entryLabel(entry({ note: '', kind: 'purchase' }))).toBe('Purchase')
  })
  it('treats a whitespace-only note as absent', () => {
    expect(entryLabel(entry({ note: '   ', kind: 'purchase' }))).toBe('Purchase')
  })
})

describe('mergeHistory', () => {
  it('includes rejected requests, which write no ledger entry', () => {
    const rows = mergeHistory(
      [entry({ created_at: '2026-10-01T00:00:00Z' })],
      [request({ status: 'rejected', reject_reason: 'Blurry', created_at: '2026-10-02T00:00:00Z' })],
    )
    expect(rows).toHaveLength(2)
    expect(rows[0].kind).toBe('rejected')
    expect(rows[0].detail).toBe('Blurry')
  })
  it('includes a pending request so the customer sees it is in flight', () => {
    const rows = mergeHistory([], [request({ status: 'pending' })])
    expect(rows.map((r) => r.kind)).toEqual(['pending'])
  })
  it('omits approved requests, which already appear as ledger entries', () => {
    const rows = mergeHistory(
      [entry({ kind: 'topup', topup_id: 'r1' })],
      [request({ id: 'r1', status: 'approved' })],
    )
    expect(rows).toHaveLength(1)
    expect(rows.map((r) => r.id)).toEqual(['e1'])
    expect(rows[0].kind).toBe('topup')
  })
  it('sorts newest first', () => {
    const rows = mergeHistory(
      [entry({ id: 'old', created_at: '2026-09-01T00:00:00Z' }),
       entry({ id: 'new', created_at: '2026-10-01T00:00:00Z' })],
      [],
    )
    expect(rows.map((r) => r.id)).toEqual(['new', 'old'])
  })
})

describe('isInsufficientBalance', () => {
  it('matches the trigger message, ignoring case', () => {
    expect(isInsufficientBalance('insufficient wallet balance')).toBe(true)
    expect(isInsufficientBalance('Insufficient Wallet Balance')).toBe(true)
  })

  it('does not match a stock refusal that also starts with "insufficient"', () => {
    expect(isInsufficientBalance('insufficient stock for item 0b8f')).toBe(false)
  })
})

describe('describePayError', () => {
  it('sends a short balance to Top up', () => {
    expect(describePayError('insufficient wallet balance'))
      .toEqual({ text: 'Not enough balance — top up first.', link: 'topup' })
  })

  it('turns a stock race into a friendly message with My Orders, never Top up and never a raw uuid', () => {
    const view = describePayError('insufficient stock for item 0b8f2c1e-aaaa-bbbb-cccc-000000000000')
    expect(view.link).toBe('orders')
    expect(view.text).toMatch(/went out of stock/)
    expect(view.text).not.toMatch(/0b8f/)
  })

  it.each([
    'order not payable (status paid)',
    'order not found',
    'forbidden',
    'this order is not set to pay from your wallet',
  ])('links permanent refusal "%s" to My Orders and keeps the server text', (raw) => {
    expect(describePayError(raw)).toEqual({ text: raw, link: 'orders' })
  })

  it('surfaces anything else as-is with no link', () => {
    expect(describePayError('Failed to fetch')).toEqual({ text: 'Failed to fetch', link: null })
  })
})
