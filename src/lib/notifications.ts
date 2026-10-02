import type { AppNotification } from '../types'

// How many of a person's newest notifications the app holds. The unread badge
// counts within this window, so it tops out here.
export const PAGE = 50

const byNewest = (a: AppNotification, b: AppNotification) =>
  Date.parse(b.created_at) - Date.parse(a.created_at)

// A realtime INSERT can also arrive in a refetch, so adding the same row twice
// would double-count the badge and repeat a React key.
export function addNotification(list: AppNotification[], incoming: AppNotification): AppNotification[] {
  if (list.some((n) => n.id === incoming.id)) return list
  return [incoming, ...list].sort(byNewest).slice(0, PAGE)
}

// Folds a fresh fetch into what the app already holds, rather than replacing it.
// Two things a replace would lose:
//  - a row Realtime delivered that the fetch's snapshot predates;
//  - a read mark applied locally while its write is still in flight. Reading is
//    one-way (nothing but a failed write puts a row back to unread, and that
//    path undoes its own mark), so a local read mark always wins.
export function mergeFetched(held: AppNotification[], fetched: AppNotification[]): AppNotification[] {
  const heldById = new Map(held.map((n) => [n.id, n]))
  const fetchedIds = new Set(fetched.map((n) => n.id))

  const merged = fetched.map((n) => {
    const local = heldById.get(n.id)
    return local?.read_at && !n.read_at ? { ...n, read_at: local.read_at } : n
  })

  // A held row the fetch lacks is either newer than the snapshot (keep it) or
  // has slid off the end of a full page (drop it). Only a full page can have
  // an end to slide off.
  const oldestFetched = fetched.length >= PAGE ? Date.parse(fetched[fetched.length - 1].created_at) : -Infinity
  const late = held.filter((n) => !fetchedIds.has(n.id) && Date.parse(n.created_at) > oldestFetched)

  return [...late, ...merged].sort(byNewest).slice(0, PAGE)
}

export function markRead(list: AppNotification[], ids: ReadonlySet<string>, at: string): AppNotification[] {
  return list.map((n) => (ids.has(n.id) && !n.read_at ? { ...n, read_at: at } : n))
}

// Undoes exactly the mark `markRead` made. Matching on the timestamp means a
// row that something else has marked read since is left alone.
export function unmarkRead(list: AppNotification[], ids: ReadonlySet<string>, at: string): AppNotification[] {
  return list.map((n) => (ids.has(n.id) && n.read_at === at ? { ...n, read_at: null } : n))
}

export function countUnread(list: AppNotification[]): number {
  return list.filter((n) => !n.read_at).length
}

// The accessible name of a nav link that shows an unread count, so the badge is
// not visual-only. Undefined when there is nothing to add, which leaves the
// link's own text as its name.
export function unreadLabel(label: string, unread: number): string | undefined {
  return unread > 0 ? `${label}, ${unread} unread` : undefined
}
