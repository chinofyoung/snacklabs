import { describe, it, expect } from 'vitest'
import { formatPeso } from './money'

describe('formatPeso', () => {
  it('formats whole pesos with two decimals', () => {
    expect(formatPeso(15)).toBe('₱15.00')
  })
  it('formats thousands with grouping', () => {
    expect(formatPeso(1234.5)).toBe('₱1,234.50')
  })
})
