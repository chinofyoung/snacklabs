export interface AiVerdictResult {
  verdict: 'pass' | 'fail' | 'unsure'
  extracted: {
    amount: number | null
    recipient: string | null
    reference: string | null
    timestamp: string | null
  }
  reason: string
}

export function decideOrderStatus(
  v: AiVerdictResult,
  orderTotal: number,
  refAlreadyUsed: boolean,
  isCash = false,
): 'paid' | 'needs_review' {
  if (v.verdict !== 'pass') return 'needs_review'
  if (v.extracted.amount === null) return 'needs_review'

  if (isCash) {
    if (v.extracted.amount >= orderTotal - 0.009) return 'paid'
    return 'needs_review'
  }

  if (refAlreadyUsed) return 'needs_review'
  if (Math.abs(v.extracted.amount - orderTotal) > 0.009) return 'needs_review'
  return 'paid'
}
