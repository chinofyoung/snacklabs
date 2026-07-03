import { describe, it, expect } from 'vitest'
import { decideOrderStatus, type AiVerdictResult } from './verdict'

const v = (over: Partial<AiVerdictResult> = {}): AiVerdictResult => ({
  verdict: 'pass',
  extracted: { amount: 60.5, recipient: 'Snack Labs', reference: 'REF123', timestamp: '2026-07-02' },
  reason: 'ok',
  ...over,
})

describe('decideOrderStatus', () => {
  it('pays when AI passes and amount matches', () => {
    expect(decideOrderStatus(v(), 60.5, false)).toBe('paid')
  })
  it('needs review when AI says fail or unsure', () => {
    expect(decideOrderStatus(v({ verdict: 'fail' }), 60.5, false)).toBe('needs_review')
    expect(decideOrderStatus(v({ verdict: 'unsure' }), 60.5, false)).toBe('needs_review')
  })
  it('needs review when amount mismatches or is missing', () => {
    expect(decideOrderStatus(v({ extracted: { ...v().extracted, amount: 60 } }), 60.5, false)).toBe('needs_review')
    expect(decideOrderStatus(v({ extracted: { ...v().extracted, amount: null } }), 60.5, false)).toBe('needs_review')
  })
  it('tolerates sub-centavo float noise', () => {
    expect(decideOrderStatus(v({ extracted: { ...v().extracted, amount: 60.500001 } }), 60.5, false)).toBe('paid')
  })
  it('needs review when the reference was already used', () => {
    expect(decideOrderStatus(v(), 60.5, true)).toBe('needs_review')
  })
})

describe('decideOrderStatus (cash mode)', () => {
  it('pays when AI passes and the counted cash exactly matches the total', () => {
    expect(decideOrderStatus(v(), 60.5, false, true)).toBe('paid')
  })
  it('pays on overpayment (counted cash exceeds the total)', () => {
    expect(decideOrderStatus(v({ extracted: { ...v().extracted, amount: 100 } }), 60.5, false, true)).toBe('paid')
  })
  it('needs review on underpayment (counted cash is less than the total)', () => {
    expect(decideOrderStatus(v({ extracted: { ...v().extracted, amount: 50 } }), 60.5, false, true)).toBe('needs_review')
  })
  it('needs review when AI says fail or unsure', () => {
    expect(decideOrderStatus(v({ verdict: 'fail' }), 60.5, false, true)).toBe('needs_review')
    expect(decideOrderStatus(v({ verdict: 'unsure' }), 60.5, false, true)).toBe('needs_review')
  })
  it('needs review when amount is null', () => {
    expect(decideOrderStatus(v({ extracted: { ...v().extracted, amount: null } }), 60.5, false, true)).toBe('needs_review')
  })
  it('ignores refAlreadyUsed for cash', () => {
    expect(decideOrderStatus(v(), 60.5, true, true)).toBe('paid')
  })
})
