import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { Bell } from 'lucide-react'
import { useNotifications } from '../context/NotificationsContext'
import type { AppNotification } from '../types'

export default function Notifications() {
  const { items, markAllRead, reload } = useNotifications()

  // Rows are marked read the moment they are on screen, so `read_at` alone could
  // never tell the person what is new. This holds the ids that were unread when
  // the page first showed them, for as long as the page stays open.
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set())
  // Ids a mark has already been attempted for. If the write fails the context
  // puts the row back to unread; without this, that would trigger the effect
  // again, and a dead connection would retry in a loop.
  const attempted = useRef(new Set<string>())

  // Seeing the list IS reading it, so the badge clears without a button press and
  // keeps meaning "things you have not looked at". It keys off `items`, not a
  // mount-time check: on a direct visit the list arrives after the first render
  // (and rows can arrive while the page is open), so a one-shot effect would
  // never see them.
  useEffect(() => {
    const unseen = items.filter((n) => !n.read_at && !attempted.current.has(n.id))
    if (unseen.length === 0) return
    unseen.forEach((n) => attempted.current.add(n.id))
    setFresh((held) => new Set([...held, ...unseen.map((n) => n.id)]))
    void markAllRead()
  }, [items, markAllRead])

  // The context already refetches when the realtime channel (re)subscribes, but a
  // half-dead socket can sit unnoticed for a while. Opening this page is the one
  // moment a stale list is plainly visible, so refetch here too; the merge never
  // blanks the list. `settled` also stops a direct visit flashing "Nothing yet"
  // before the first fetch lands.
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    void reload().finally(() => setSettled(true))
  }, [reload])

  return (
    <div className="max-w-md mx-auto px-4 py-4 space-y-4 pb-28 app-frame">
      <h1 className="font-display text-xl font-bold">Alerts</h1>

      {items.length > 0 ? (
        <ul className="space-y-2">
          {items.map((n) => (
            <li key={n.id}>
              <NotificationRow notification={n} isNew={!n.read_at || fresh.has(n.id)} />
            </li>
          ))}
        </ul>
      ) : settled ? (
        <div className="text-center py-12 space-y-2">
          <Bell className="size-12 mx-auto text-ink-500" strokeWidth={2.5} aria-hidden="true" />
          <p className="text-ink-700 font-medium">Nothing yet</p>
          <p className="text-ink-700 text-sm">
            Top-up updates and anything that needs your attention will show up here.
          </p>
        </div>
      ) : (
        <p className="text-center text-ink-700 py-8">Loading…</p>
      )}
    </div>
  )
}

function NotificationRow({ notification: n, isNew }: { notification: AppNotification; isNew: boolean }) {
  const className = `block rounded-lg p-3 shadow-card ${isNew ? 'bg-brand-50' : 'bg-surface-raised'}`
  const content = (
    <>
      <div className="flex items-start justify-between gap-2">
        <p className={`text-sm ${isNew ? 'font-bold' : 'font-medium'}`}>{n.title}</p>
        {/* Text, not just the tint: the tint is 1.04:1 against the page, and a
            screen reader cannot see it. brand-700 keeps white text at 4.81:1. */}
        {isNew && (
          <span className="shrink-0 rounded-full bg-brand-700 px-2 py-0.5 text-xs font-bold text-white">New</span>
        )}
      </div>
      <p className="text-sm text-ink-700 mt-0.5">{n.body}</p>
      {/* ink-700, not ink-500: ink-500 is 3.57:1 on the unread tint, under AA. */}
      <p className="text-xs text-ink-700 mt-1">
        <time dateTime={n.created_at}>{new Date(n.created_at).toLocaleString()}</time>
      </p>
    </>
  )

  // A notification with no destination is not a link: pointing it at the page
  // you are already on would only add a dead tab stop.
  return n.link ? (
    <Link to={n.link} className={className}>
      {content}
    </Link>
  ) : (
    <div className={className}>{content}</div>
  )
}
