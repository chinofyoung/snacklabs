import { describe, expect, it } from 'vitest'
import {
  AUDIENCE_OF_KIND, PAGE, addNotification, audienceOf, countUnread, countUnreadByAudience, inAudience,
  markRead, mergeFetched, unmarkRead, unreadLabel,
} from './notifications'
import type { NotificationAudience } from './notifications'
import type { AppNotification, NotificationKind } from '../types'

// Minutes after a fixed origin, so a larger `n` is a newer row.
function row(n: number, read_at: string | null = null, kind: NotificationKind = 'topup_approved'): AppNotification {
  return {
    id: `n${n}`, user_id: 'u1', kind, title: `t${n}`, body: '', link: '',
    read_at, created_at: new Date(Date.UTC(2026, 9, 2, 0, n)).toISOString(),
  }
}

const ids = (list: AppNotification[]) => list.map((n) => n.id)

describe('addNotification', () => {
  it('puts the newest row first', () => {
    expect(ids(addNotification([row(1)], row(2)))).toEqual(['n2', 'n1'])
  })

  it('ignores a row it already holds, so a refetch and an INSERT cannot double-count', () => {
    const list = [row(2), row(1)]
    expect(addNotification(list, row(2))).toBe(list)
  })

  it('caps the list at one page, dropping the oldest', () => {
    const full = Array.from({ length: PAGE }, (_, i) => row(PAGE - i))
    const next = addNotification(full, row(PAGE + 1))
    expect(next).toHaveLength(PAGE)
    expect(next[0].id).toBe(`n${PAGE + 1}`)
    expect(ids(next)).not.toContain('n1')
  })
})

describe('mergeFetched', () => {
  it('takes the fetched rows when nothing is held', () => {
    expect(ids(mergeFetched([], [row(2), row(1)]))).toEqual(['n2', 'n1'])
  })

  it('keeps a row Realtime delivered that the fetch snapshot predates', () => {
    expect(ids(mergeFetched([row(3), row(1)], [row(2), row(1)]))).toEqual(['n3', 'n2', 'n1'])
  })

  it('drops a held row that has slid off the end of a full page', () => {
    const fetched = Array.from({ length: PAGE }, (_, i) => row(PAGE + 10 - i)) // n60 .. n11
    const merged = mergeFetched([row(5)], fetched)
    expect(merged).toHaveLength(PAGE)
    expect(ids(merged)).not.toContain('n5')
  })

  it('keeps an old held row when the fetch was not a full page', () => {
    // Fewer than PAGE rows means the fetch saw everything, so a held row it
    // lacks can only be newer than its snapshot, never one that slid off.
    expect(ids(mergeFetched([row(5)], [row(9), row(8)]))).toEqual(['n9', 'n8', 'n5'])
  })

  it('lets a local read mark win over a snapshot taken before its write landed', () => {
    const at = '2026-10-02T01:00:00.000Z'
    const merged = mergeFetched([row(1, at)], [row(1)])
    expect(merged[0].read_at).toBe(at)
    expect(countUnread(merged)).toBe(0)
  })

  it('takes the fetched read state when the row was read elsewhere', () => {
    const at = '2026-10-02T01:00:00.000Z'
    expect(mergeFetched([row(1)], [row(1, at)])[0].read_at).toBe(at)
  })
})

describe('markRead / unmarkRead', () => {
  const at = '2026-10-02T01:00:00.000Z'

  it('marks only the named unread rows and leaves other rows untouched', () => {
    const list = [row(3), row(2), row(1, 'earlier')]
    const next = markRead(list, new Set(['n3', 'n1']), at)
    expect(next.map((n) => n.read_at)).toEqual([at, null, 'earlier'])
  })

  it('does not overwrite an earlier read timestamp', () => {
    expect(markRead([row(1, 'earlier')], new Set(['n1']), at)[0].read_at).toBe('earlier')
  })

  it('unmarks exactly what markRead set', () => {
    const marked = markRead([row(2), row(1)], new Set(['n2', 'n1']), at)
    expect(countUnread(unmarkRead(marked, new Set(['n2', 'n1']), at))).toBe(2)
  })

  it('leaves alone a row that something else marked read in the meantime', () => {
    const list = [row(1, 'someone-else')]
    expect(unmarkRead(list, new Set(['n1']), at)[0].read_at).toBe('someone-else')
  })
})

describe('countUnread', () => {
  it('counts rows with no read_at', () => {
    expect(countUnread([row(1), row(2, 'x'), row(3)])).toBe(2)
  })
})

describe('unreadLabel', () => {
  it('puts the count in the accessible name', () => {
    expect(unreadLabel('Alerts', 3)).toBe('Alerts, 3 unread')
  })

  it('gives the true count even where the badge shows 9+', () => {
    expect(unreadLabel('Alerts', 14)).toBe('Alerts, 14 unread')
  })

  it('leaves the link on its own text when nothing is unread', () => {
    expect(unreadLabel('Alerts', 0)).toBeUndefined()
  })
})

// Spelled out for every kind, and typed as a Record so tsc rejects a table that
// is missing one. A kind added to NotificationKind without being classified in
// notifications.ts fails the build; one added there without being listed here
// fails the key-set test below.
const EXPECTED_AUDIENCE: Record<NotificationKind, NotificationAudience> = {
  topup_requested: 'admin',
  registration_pending: 'admin',
  order_needs_review: 'admin',
  topup_approved: 'customer',
  topup_rejected: 'customer',
}

describe('audienceOf', () => {
  it.each(Object.entries(EXPECTED_AUDIENCE) as [NotificationKind, NotificationAudience][])(
    'files %s under %s',
    (kind, audience) => {
      expect(audienceOf(kind)).toBe(audience)
    },
  )

  it('classifies exactly the kinds this suite lists, so a new kind cannot go unclassified', () => {
    expect(Object.keys(AUDIENCE_OF_KIND).sort()).toEqual(Object.keys(EXPECTED_AUDIENCE).sort())
  })

  it('gives every kind one of the two audiences', () => {
    for (const kind of Object.keys(AUDIENCE_OF_KIND) as NotificationKind[]) {
      expect(['admin', 'customer']).toContain(audienceOf(kind))
    }
  })
})

describe('inAudience', () => {
  const mixed = [
    row(5, null, 'topup_approved'),
    row(4, null, 'order_needs_review'),
    row(3, null, 'registration_pending'),
    row(2, null, 'topup_rejected'),
    row(1, null, 'topup_requested'),
  ]

  it('keeps only the admin kinds, in order', () => {
    expect(ids(inAudience(mixed, 'admin'))).toEqual(['n4', 'n3', 'n1'])
  })

  it('keeps only the customer kinds, in order', () => {
    expect(ids(inAudience(mixed, 'customer'))).toEqual(['n5', 'n2'])
  })

  it('splits a list with nothing left over or counted twice', () => {
    expect(inAudience(mixed, 'admin').length + inAudience(mixed, 'customer').length).toBe(mixed.length)
  })

  it('leaves a kind this bundle does not know out of both audiences', () => {
    const future = [{ ...row(1), kind: 'something_new' as unknown as NotificationKind }]
    expect(inAudience(future, 'admin')).toEqual([])
    expect(inAudience(future, 'customer')).toEqual([])
  })
})

describe('countUnreadByAudience', () => {
  it('counts each audience on its own, ignoring the other side and read rows', () => {
    const list = [
      row(5, null, 'topup_approved'),
      row(4, null, 'order_needs_review'),
      row(3, 'read', 'registration_pending'),
      row(2, null, 'topup_requested'),
      row(1, 'read', 'topup_rejected'),
    ]
    expect(countUnreadByAudience(list)).toEqual({ admin: 2, customer: 1 })
  })

  it('is zero on both sides for an empty list', () => {
    expect(countUnreadByAudience([])).toEqual({ admin: 0, customer: 0 })
  })

  it('does not let reading one audience clear the other', () => {
    const list = [row(2, null, 'topup_approved'), row(1, null, 'order_needs_review')]
    const adminIds = new Set(inAudience(list, 'admin').map((n) => n.id))
    expect(countUnreadByAudience(markRead(list, adminIds, '2026-10-02T01:00:00.000Z'))).toEqual({
      admin: 0, customer: 1,
    })
  })
})
