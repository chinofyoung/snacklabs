import { describe, it, expect, afterEach } from 'vitest'
import { rangeFor, bucketsFor, bucketIndexFor } from './salesRange'

// @types/node isn't registered in this project's tsconfig.app.json `types`
// array (kept minimal for the browser app), so `process` isn't otherwise
// recognized. Declare just the shape this file needs. Because this file is
// a module (it has top-level imports), a plain top-level `declare const` is
// scoped to this file only - it does not leak into the global scope or any
// other file, unlike registering "node" in tsconfig.app.json would.
declare const process: { env: { TZ?: string } }

const DAY_MS = 24 * 60 * 60 * 1000

describe('rangeFor', () => {
  it('day: returns start of day through start of the next day', () => {
    const now = new Date(2026, 8, 4, 14, 30, 45, 123)
    const { start, end } = rangeFor('day', now)
    expect(start).toEqual(new Date(2026, 8, 4, 0, 0, 0, 0))
    expect(end).toEqual(new Date(2026, 8, 5, 0, 0, 0, 0))
  })

  it('week: resolves a Sunday to the previous Monday through the following Monday', () => {
    // 2026-09-06 is a Sunday
    const now = new Date(2026, 8, 6, 15, 30, 0, 0)
    const { start, end } = rangeFor('week', now)
    expect(start).toEqual(new Date(2026, 7, 31, 0, 0, 0, 0))
    expect(end).toEqual(new Date(2026, 8, 7, 0, 0, 0, 0))
  })

  it('week: resolves a mid-week Thursday to that week\'s Monday through the following Monday', () => {
    // 2026-09-03 is a Thursday, in the same week as Monday 2026-08-31
    const now = new Date(2026, 8, 3, 23, 59, 59, 999)
    const { start, end } = rangeFor('week', now)
    expect(start).toEqual(new Date(2026, 7, 31, 0, 0, 0, 0))
    expect(end).toEqual(new Date(2026, 8, 7, 0, 0, 0, 0))
  })

  it('month: returns the 1st of the month through the 1st of the next month', () => {
    const now = new Date(2026, 8, 15, 12, 0, 0, 0)
    const { start, end } = rangeFor('month', now)
    expect(start).toEqual(new Date(2026, 8, 1, 0, 0, 0, 0))
    expect(end).toEqual(new Date(2026, 9, 1, 0, 0, 0, 0))
  })

  it('year: returns Jan 1 through Jan 1 of the next year', () => {
    const now = new Date(2026, 8, 15, 12, 0, 0, 0)
    const { start, end } = rangeFor('year', now)
    expect(start).toEqual(new Date(2026, 0, 1, 0, 0, 0, 0))
    expect(end).toEqual(new Date(2027, 0, 1, 0, 0, 0, 0))
  })

  it('end is exclusive: the instant exactly at end does not belong to the range', () => {
    const now = new Date(2026, 8, 4, 14, 30, 45, 123)
    const { start, end } = rangeFor('day', now)
    const buckets = [{ start }]
    expect(bucketIndexFor(end, buckets, end)).toBe(-1)
  })

  it('does not mutate the passed-in now argument', () => {
    const now = new Date(2026, 8, 6, 15, 30, 45, 500)
    const before = now.getTime()
    rangeFor('week', now)
    expect(now.getTime()).toBe(before)
  })
})

describe('bucketsFor', () => {
  describe('unit selection', () => {
    const start = new Date(2026, 8, 4, 0, 0, 0, 0)

    it('spanMs just under 2 days selects hour', () => {
      const end = new Date(start.getTime() + 2 * DAY_MS - 1)
      expect(bucketsFor(start, end).unit).toBe('hour')
    })

    it('spanMs exactly 2 days selects hour (<= is inclusive of hour)', () => {
      const end = new Date(start.getTime() + 2 * DAY_MS)
      expect(bucketsFor(start, end).unit).toBe('hour')
    })

    it('spanMs just over 2 days selects day', () => {
      const end = new Date(start.getTime() + 2 * DAY_MS + 1)
      expect(bucketsFor(start, end).unit).toBe('day')
    })

    it('spanMs just under 92 days selects day', () => {
      const end = new Date(start.getTime() + 92 * DAY_MS - 1)
      expect(bucketsFor(start, end).unit).toBe('day')
    })

    it('spanMs exactly 92 days selects day (<= is inclusive of day)', () => {
      const end = new Date(start.getTime() + 92 * DAY_MS)
      expect(bucketsFor(start, end).unit).toBe('day')
    })

    it('spanMs just over 92 days selects month', () => {
      const end = new Date(start.getTime() + 92 * DAY_MS + 1)
      expect(bucketsFor(start, end).unit).toBe('month')
    })
  })

  it('tiles hour buckets with no gap or overlap', () => {
    const start = new Date(2026, 8, 4, 0, 0, 0, 0)
    const end = new Date(2026, 8, 4, 5, 0, 0, 0)
    const { unit, buckets } = bucketsFor(start, end)
    expect(unit).toBe('hour')
    expect(buckets).toHaveLength(5)
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i].start.getTime()).toBe(buckets[i - 1].start.getTime() + 60 * 60 * 1000)
    }
    expect(buckets[0].start).toEqual(new Date(2026, 8, 4, 0, 0, 0, 0))
    // the last bucket has no next bucket, so its implicit end is `end` itself
    expect(buckets[buckets.length - 1].start.getTime() + 60 * 60 * 1000).toBe(end.getTime())
  })

  it('tiles day buckets with no gap or overlap', () => {
    const start = new Date(2026, 8, 1, 0, 0, 0, 0)
    const end = new Date(2026, 8, 11, 0, 0, 0, 0)
    const { unit, buckets } = bucketsFor(start, end)
    expect(unit).toBe('day')
    expect(buckets).toHaveLength(10)
    for (let i = 1; i < buckets.length; i++) {
      const prev = buckets[i - 1].start
      const expected = new Date(prev.getFullYear(), prev.getMonth(), prev.getDate() + 1, 0, 0, 0, 0)
      expect(buckets[i].start).toEqual(expected)
    }
    expect(buckets[0].start).toEqual(new Date(2026, 8, 1, 0, 0, 0, 0))
    expect(buckets[buckets.length - 1].start).toEqual(new Date(2026, 8, 10, 0, 0, 0, 0))
  })

  it('tiles month buckets with no gap or overlap', () => {
    const start = new Date(2026, 0, 1, 0, 0, 0, 0)
    const end = new Date(2027, 0, 1, 0, 0, 0, 0)
    const { unit, buckets } = bucketsFor(start, end)
    expect(unit).toBe('month')
    expect(buckets).toHaveLength(12)
    for (let i = 0; i < buckets.length; i++) {
      expect(buckets[i].start).toEqual(new Date(2026, i, 1, 0, 0, 0, 0))
    }
  })

  it('produces exactly one bucket for a span shorter than a full unit step', () => {
    const start = new Date(2026, 8, 4, 10, 0, 0, 0)
    const end = new Date(2026, 8, 4, 10, 30, 0, 0)
    const { unit, buckets } = bucketsFor(start, end)
    expect(unit).toBe('hour')
    expect(buckets).toHaveLength(1)
    expect(buckets[0].start).toEqual(start)
  })

  it('month buckets from a non-day-1 start produce a short first bucket without skipping or duplicating a month (Jan 31 rollover)', () => {
    // A naive cursor.setMonth(cursor.getMonth() + 1) on Jan 31 would land on
    // Mar 3 (Feb only has 28 days in 2026), skipping February entirely.
    const start = new Date(2026, 0, 31, 0, 0, 0, 0)
    const end = new Date(2026, 5, 1, 0, 0, 0, 0)
    const { unit, buckets } = bucketsFor(start, end)
    expect(unit).toBe('month')
    expect(buckets.map((b) => b.start)).toEqual([
      new Date(2026, 0, 31, 0, 0, 0, 0),
      new Date(2026, 1, 1, 0, 0, 0, 0),
      new Date(2026, 2, 1, 0, 0, 0, 0),
      new Date(2026, 3, 1, 0, 0, 0, 0),
      new Date(2026, 4, 1, 0, 0, 0, 0),
    ])
    expect(buckets.map((b) => b.label)).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May'])
  })

  it('produces correctly formatted labels per unit', () => {
    const hour = bucketsFor(new Date(2026, 8, 4, 15, 0, 0, 0), new Date(2026, 8, 4, 16, 0, 0, 0))
    expect(hour.buckets[0].label).toBe('3 PM')

    const day = bucketsFor(new Date(2026, 8, 4, 0, 0, 0, 0), new Date(2026, 8, 7, 0, 0, 0, 0))
    expect(day.buckets[0].label).toBe('Sep 4')

    const month = bucketsFor(new Date(2026, 0, 1, 0, 0, 0, 0), new Date(2026, 4, 1, 0, 0, 0, 0))
    expect(month.buckets[0].label).toBe('Jan')
  })

  it('does not mutate the start or end params', () => {
    const start = new Date(2026, 8, 4, 0, 0, 0, 0)
    const end = new Date(2026, 8, 6, 0, 0, 0, 0)
    const startBefore = start.getTime()
    const endBefore = end.getTime()
    bucketsFor(start, end)
    expect(start.getTime()).toBe(startBefore)
    expect(end.getTime()).toBe(endBefore)
  })

  describe('across a DST transition', () => {
    const originalTz = process.env.TZ

    afterEach(() => {
      process.env.TZ = originalTz
    })

    it('day buckets land on local midnight through US spring-forward 2026 (America/New_York, Mar 8)', () => {
      process.env.TZ = 'America/New_York'

      // Spans Sat Mar 7 through Mon Mar 9. Mar 8 -> Mar 9 is the 23-hour
      // short day created by the spring-forward transition (clocks jump
      // from 2:00 AM to 3:00 AM on Mar 8, 2026).
      const start = new Date(2026, 2, 7, 0, 0, 0, 0)
      const end = new Date(2026, 2, 10, 0, 0, 0, 0)
      const { unit, buckets } = bucketsFor(start, end)

      expect(unit).toBe('day')
      expect(buckets).toHaveLength(3)
      expect(buckets.map((b) => b.start)).toEqual([
        new Date(2026, 2, 7, 0, 0, 0, 0),
        new Date(2026, 2, 8, 0, 0, 0, 0),
        new Date(2026, 2, 9, 0, 0, 0, 0),
      ])
      // Every bucket must land exactly on local midnight. If the
      // implementation ever steps the cursor by a fixed 24 * DAY_MS
      // milliseconds instead of cursor.setDate(cursor.getDate() + 1), this
      // drifts by an hour once it crosses the transition and fails.
      for (const bucket of buckets) {
        expect(bucket.start.getHours()).toBe(0)
        expect(bucket.start.getMinutes()).toBe(0)
      }
      expect(buckets.map((b) => b.label)).toEqual(['Mar 7', 'Mar 8', 'Mar 9'])
    })
  })
})

describe('bucketIndexFor', () => {
  const buckets = [
    { start: new Date(2026, 8, 1, 0, 0, 0, 0) },
    { start: new Date(2026, 8, 2, 0, 0, 0, 0) },
    { start: new Date(2026, 8, 3, 0, 0, 0, 0) },
  ]
  const end = new Date(2026, 8, 4, 0, 0, 0, 0)

  it('resolves a bucket\'s first instant to that bucket\'s index', () => {
    expect(bucketIndexFor(buckets[0].start, buckets, end)).toBe(0)
    expect(bucketIndexFor(buckets[1].start, buckets, end)).toBe(1)
    expect(bucketIndexFor(buckets[2].start, buckets, end)).toBe(2)
  })

  it('resolves a bucket\'s last instant to that same bucket\'s index, not the next one', () => {
    const oneMsBeforeSecondBucket = new Date(buckets[1].start.getTime() - 1)
    expect(bucketIndexFor(oneMsBeforeSecondBucket, buckets, end)).toBe(0)

    const oneMsBeforeThirdBucket = new Date(buckets[2].start.getTime() - 1)
    expect(bucketIndexFor(oneMsBeforeThirdBucket, buckets, end)).toBe(1)

    const oneMsBeforeEnd = new Date(end.getTime() - 1)
    expect(bucketIndexFor(oneMsBeforeEnd, buckets, end)).toBe(2)
  })

  it('returns -1 exactly at end (exclusive upper boundary)', () => {
    expect(bucketIndexFor(end, buckets, end)).toBe(-1)
  })

  it('returns -1 for a date before the first bucket\'s start', () => {
    const before = new Date(buckets[0].start.getTime() - 1)
    expect(bucketIndexFor(before, buckets, end)).toBe(-1)
  })

  it('returns -1 for an empty buckets array', () => {
    expect(bucketIndexFor(new Date(2026, 8, 1, 12, 0, 0, 0), [], end)).toBe(-1)
  })

  it('does not mutate the date, buckets, or end params', () => {
    const date = new Date(buckets[1].start.getTime() + 1000)
    const dateBefore = date.getTime()
    const endBefore = end.getTime()
    const bucketTimesBefore = buckets.map((b) => b.start.getTime())
    bucketIndexFor(date, buckets, end)
    expect(date.getTime()).toBe(dateBefore)
    expect(end.getTime()).toBe(endBefore)
    expect(buckets.map((b) => b.start.getTime())).toEqual(bucketTimesBefore)
  })
})
