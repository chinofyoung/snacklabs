import { describe, it, expect } from 'vitest'
import { rankBuyers } from './salesPeople'
import type { PaidOrderRow } from './salesPeople'

const row = (over: Partial<PaidOrderRow> = {}): PaidOrderRow => ({
  id: 'o1',
  user_id: 'u1',
  total: 100,
  created_at: '2026-01-01T00:00:00.000Z',
  profiles: { full_name: 'Alice', email: 'alice@example.com' },
  ...over,
})

describe('rankBuyers', () => {
  it('sums multiple orders placed by the same buyer', () => {
    const orders = [
      row({ id: 'o1', user_id: 'u1', total: 100 }),
      row({ id: 'o2', user_id: 'u1', total: 50 }),
    ]
    const result = rankBuyers(orders)
    expect(result).toHaveLength(1)
    expect(result[0].total).toBe(150)
  })

  it('ranks buyers in descending order by total spent', () => {
    const orders = [
      row({ id: 'o1', user_id: 'u1', total: 50, profiles: { full_name: 'Low Spender', email: 'low@example.com' } }),
      row({ id: 'o2', user_id: 'u2', total: 200, profiles: { full_name: 'High Spender', email: 'high@example.com' } }),
    ]
    const result = rankBuyers(orders)
    expect(result.map((b) => b.userId)).toEqual(['u2', 'u1'])
  })

  it('breaks a tie in total by orderCount, descending', () => {
    const orders = [
      row({ id: 'o1', user_id: 'u1', total: 100, profiles: { full_name: 'One Order', email: 'one@example.com' } }),
      row({ id: 'o2', user_id: 'u2', total: 50, profiles: { full_name: 'Two Orders', email: 'two@example.com' } }),
      row({ id: 'o3', user_id: 'u2', total: 50, profiles: { full_name: 'Two Orders', email: 'two@example.com' } }),
    ]
    const result = rankBuyers(orders)
    expect(result.map((b) => b.userId)).toEqual(['u2', 'u1'])
  })

  it('breaks a tie in total and orderCount by name, ascending', () => {
    const orders = [
      row({ id: 'o1', user_id: 'u1', total: 100, profiles: { full_name: 'Zed', email: 'zed@example.com' } }),
      row({ id: 'o2', user_id: 'u2', total: 100, profiles: { full_name: 'Amy', email: 'amy@example.com' } }),
    ]
    const result = rankBuyers(orders)
    expect(result.map((b) => b.name)).toEqual(['Amy', 'Zed'])
  })

  it('uses full_name, trimmed, when present', () => {
    const result = rankBuyers([row({ profiles: { full_name: '  Alice Cruz  ', email: 'alice@example.com' } })])
    expect(result[0].name).toBe('Alice Cruz')
  })

  it('falls back to email when full_name is empty', () => {
    const result = rankBuyers([row({ profiles: { full_name: '', email: 'alice@example.com' } })])
    expect(result[0].name).toBe('alice@example.com')
  })

  it('treats a whitespace-only full_name as empty and falls back to email', () => {
    const result = rankBuyers([row({ profiles: { full_name: '   ', email: 'alice@example.com' } })])
    expect(result[0].name).toBe('alice@example.com')
  })

  it('falls back to Unknown, and reports an empty email, when the profile embed is missing', () => {
    const result = rankBuyers([row({ profiles: null })])
    expect(result[0].name).toBe('Unknown')
    expect(result[0].email).toBe('')
  })

  it('coerces a numeric-string total, as postgrest returns for numeric columns', () => {
    // PaidOrderRow types total as number, but postgrest serializes Postgres
    // `numeric` columns as strings to avoid float precision loss; the cast
    // simulates that real wire shape past the compile-time type.
    const orders = [
      row({ id: 'o1', total: '19.99' as unknown as number }),
      row({ id: 'o2', total: '5.01' as unknown as number }),
    ]
    expect(rankBuyers(orders)[0].total).toBe(25)
  })

  it('counts the number of orders per buyer', () => {
    const orders = [row({ id: 'o1' }), row({ id: 'o2' }), row({ id: 'o3' })]
    expect(rankBuyers(orders)[0].orderCount).toBe(3)
  })

  it('picks the most recent created_at as lastPurchase, regardless of input order', () => {
    const orders = [
      row({ id: 'o1', created_at: '2026-01-05T00:00:00.000Z' }),
      row({ id: 'o2', created_at: '2026-01-10T00:00:00.000Z' }),
      row({ id: 'o3', created_at: '2026-01-02T00:00:00.000Z' }),
    ]
    expect(rankBuyers(orders)[0].lastPurchase).toBe('2026-01-10T00:00:00.000Z')
  })

  it('aggregates independently across multiple buyers with multiple orders each', () => {
    const orders = [
      row({ id: 'o1', user_id: 'u1', total: 30, created_at: '2026-01-01T00:00:00.000Z' }),
      row({ id: 'o2', user_id: 'u2', total: 10, created_at: '2026-01-02T00:00:00.000Z', profiles: { full_name: 'Bob', email: 'bob@example.com' } }),
      row({ id: 'o3', user_id: 'u1', total: 40, created_at: '2026-01-03T00:00:00.000Z' }),
      row({ id: 'o4', user_id: 'u2', total: 10, created_at: '2026-01-04T00:00:00.000Z', profiles: { full_name: 'Bob', email: 'bob@example.com' } }),
    ]
    const result = rankBuyers(orders)
    expect(result).toEqual([
      {
        userId: 'u1',
        name: 'Alice',
        email: 'alice@example.com',
        total: 70,
        orderCount: 2,
        lastPurchase: '2026-01-03T00:00:00.000Z',
      },
      {
        userId: 'u2',
        name: 'Bob',
        email: 'bob@example.com',
        total: 20,
        orderCount: 2,
        lastPurchase: '2026-01-04T00:00:00.000Z',
      },
    ])
  })

  it('returns an empty array for empty input', () => {
    expect(rankBuyers([])).toEqual([])
  })

  it('does not mutate the input array', () => {
    const orders = [row({ id: 'o1' }), row({ id: 'o2', user_id: 'u2' })]
    const snapshot = JSON.parse(JSON.stringify(orders))
    rankBuyers(orders)
    expect(orders).toEqual(snapshot)
  })
})
