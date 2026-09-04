export type Period = 'all' | 'day' | 'week' | 'month' | 'year'

export const PERIODS: readonly Period[] = ['all', 'day', 'week', 'month', 'year']

export function periodStart(p: Period, now: Date = new Date()): Date | null {
  if (p === 'all') return null

  const d = new Date(now.getTime())

  if (p === 'day') {
    d.setHours(0, 0, 0, 0)
    return d
  }

  if (p === 'week') {
    const day = d.getDay()
    const offset = (day + 6) % 7
    d.setDate(d.getDate() - offset)
    d.setHours(0, 0, 0, 0)
    return d
  }

  if (p === 'month') {
    return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0)
  }

  return new Date(d.getFullYear(), 0, 1, 0, 0, 0, 0)
}

export function periodLabel(p: Period): string {
  switch (p) {
    case 'all':
      return 'All time'
    case 'day':
      return 'Today'
    case 'week':
      return 'This week'
    case 'month':
      return 'This month'
    case 'year':
      return 'This year'
  }
}
