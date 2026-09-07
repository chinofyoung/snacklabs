import { periodStart } from './period'

export type RangePreset = 'day' | 'week' | 'month' | 'year' | 'custom'

const DAY_MS = 24 * 60 * 60 * 1000

export function rangeFor(preset: Exclude<RangePreset, 'custom'>, now?: Date): { start: Date; end: Date } {
  // periodStart only returns null for the 'all' period. `preset` here is
  // Exclude<RangePreset, 'custom'>, which never includes 'all', so the
  // result is always a Date - this assertion is safe.
  const start = periodStart(preset, now) as Date

  const end = new Date(start.getTime())
  if (preset === 'day') {
    end.setDate(end.getDate() + 1)
  } else if (preset === 'week') {
    end.setDate(end.getDate() + 7)
  } else if (preset === 'month') {
    end.setMonth(end.getMonth() + 1)
  } else {
    end.setFullYear(end.getFullYear() + 1)
  }

  return { start, end }
}

export function bucketsFor(start: Date, end: Date): { unit: 'hour' | 'day' | 'month'; buckets: { start: Date; label: string }[] } {
  const spanMs = end.getTime() - start.getTime()
  const unit: 'hour' | 'day' | 'month' = spanMs <= 2 * DAY_MS ? 'hour' : spanMs <= 92 * DAY_MS ? 'day' : 'month'

  const buckets: { start: Date; label: string }[] = []
  let cursor = new Date(start.getTime())

  if (unit === 'hour') {
    while (cursor < end) {
      const bucketStart = new Date(cursor.getTime())
      buckets.push({ start: bucketStart, label: bucketStart.toLocaleTimeString('en-US', { hour: 'numeric' }) })
      cursor.setHours(cursor.getHours() + 1)
    }
  } else if (unit === 'day') {
    while (cursor < end) {
      const bucketStart = new Date(cursor.getTime())
      buckets.push({ start: bucketStart, label: bucketStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) })
      // Step by calendar day via setDate, never by adding a fixed 24 * DAY_MS
      // milliseconds: across a DST transition a real local day is 23 or 25
      // hours, so a fixed-ms step drifts the cursor off local midnight and
      // can skip or duplicate a day's bucket. setDate preserves local
      // calendar-day semantics through DST.
      cursor.setDate(cursor.getDate() + 1)
    }
  } else {
    while (cursor < end) {
      const bucketStart = new Date(cursor.getTime())
      buckets.push({ start: bucketStart, label: bucketStart.toLocaleDateString('en-US', { month: 'short' }) })
      // Rebuild the cursor at day 1 of the next month instead of calling
      // setMonth(getMonth() + 1) on the existing (possibly non-day-1) cursor:
      // e.g. Jan 31 + 1 month rolls into March, not Feb 28. Constructing a
      // fresh Date at (year, month + 1, 1) is always day-overflow-safe,
      // which matters because a custom range's start need not fall on the
      // 1st - the first bucket can be a short partial month.
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1, 0, 0, 0, 0)
    }
  }

  return { unit, buckets }
}

export function bucketIndexFor(date: Date, buckets: { start: Date }[], end: Date): number {
  if (buckets.length === 0) return -1

  const t = date.getTime()
  if (t < buckets[0].start.getTime()) return -1
  if (t >= end.getTime()) return -1

  for (let i = buckets.length - 1; i >= 0; i--) {
    if (buckets[i].start.getTime() <= t) return i
  }

  return -1
}
