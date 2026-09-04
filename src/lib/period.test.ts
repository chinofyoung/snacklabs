import { describe, it, expect } from 'vitest'
import { periodStart, periodLabel, PERIODS } from './period'
import type { Period } from './period'

describe('periodStart', () => {
  it('resolves a Sunday to the previous Monday', () => {
    // 2026-09-06 is a Sunday
    const now = new Date(2026, 8, 6, 15, 30, 0, 0)
    const start = periodStart('week', now)
    expect(start).not.toBeNull()
    expect(start!.getFullYear()).toBe(2026)
    expect(start!.getMonth()).toBe(7)
    expect(start!.getDate()).toBe(31)
    expect(start!.getHours()).toBe(0)
    expect(start!.getMinutes()).toBe(0)
    expect(start!.getSeconds()).toBe(0)
    expect(start!.getMilliseconds()).toBe(0)
  })

  it('resolves a Monday to that same Monday at midnight', () => {
    // 2026-08-31 is a Monday
    const now = new Date(2026, 7, 31, 9, 0, 0, 0)
    const start = periodStart('week', now)
    expect(start).toEqual(new Date(2026, 7, 31, 0, 0, 0, 0))
  })

  it('resolves a mid-week Thursday to that week\'s Monday', () => {
    // 2026-09-03 is a Thursday, in the same week as Monday 2026-08-31
    const now = new Date(2026, 8, 3, 23, 59, 59, 999)
    const start = periodStart('week', now)
    expect(start).toEqual(new Date(2026, 7, 31, 0, 0, 0, 0))
  })

  it('returns today with the time zeroed out for "day"', () => {
    const now = new Date(2026, 8, 4, 14, 30, 45, 123)
    const start = periodStart('day', now)
    expect(start).toEqual(new Date(2026, 8, 4, 0, 0, 0, 0))
  })

  it('returns the 1st of the month at midnight for "month"', () => {
    const now = new Date(2026, 8, 15, 12, 0, 0, 0)
    const start = periodStart('month', now)
    expect(start).toEqual(new Date(2026, 8, 1, 0, 0, 0, 0))
  })

  it('returns Jan 1 of the year at midnight for "year"', () => {
    const now = new Date(2026, 8, 15, 12, 0, 0, 0)
    const start = periodStart('year', now)
    expect(start).toEqual(new Date(2026, 0, 1, 0, 0, 0, 0))
  })

  it('returns null for "all", with or without a now argument', () => {
    expect(periodStart('all')).toBeNull()
    expect(periodStart('all', new Date(2026, 8, 4))).toBeNull()
  })

  it('does not mutate the passed-in now argument', () => {
    const now = new Date(2026, 8, 6, 15, 30, 45, 500)
    const before = now.getTime()
    periodStart('week', now)
    expect(now.getTime()).toBe(before)
  })
})

describe('periodLabel', () => {
  it('returns the correct label for each period', () => {
    const expected: Record<Period, string> = {
      all: 'All time',
      day: 'Today',
      week: 'This week',
      month: 'This month',
      year: 'This year',
    }
    for (const p of PERIODS) {
      expect(periodLabel(p)).toBe(expected[p])
    }
  })
})
