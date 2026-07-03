import { describe, it, expect } from 'vitest'
import { computeCost, USD_TO_PHP } from './pricing'

describe('computeCost (claude-opus-4-8)', () => {
  it('prices input + output', () => {
    // 1000 in @ $5/M = 0.005 ; 500 out @ $25/M = 0.0125 ; total 0.0175
    const c = computeCost({ input_tokens: 1000, output_tokens: 500 })
    expect(c.cost_usd).toBeCloseTo(0.0175, 6)
    expect(c.cost_php).toBeCloseTo(0.0175 * USD_TO_PHP, 6)
  })
  it('includes cache read + write tokens', () => {
    expect(computeCost({ cache_read_input_tokens: 1_000_000 }).cost_usd).toBeCloseTo(0.5, 6)
    expect(computeCost({ cache_creation_input_tokens: 1_000_000 }).cost_usd).toBeCloseTo(6.25, 6)
  })
  it('handles absent/null usage as zero', () => {
    expect(computeCost({}).cost_usd).toBe(0)
    expect(computeCost({ input_tokens: null, output_tokens: null }).cost_usd).toBe(0)
  })
})
