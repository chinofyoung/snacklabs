import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { Bell } from 'lucide-react'
import { useNotifications } from '../context/NotificationsContext'
import { inAudience } from '../lib/notifications'
import type { NotificationAudience } from '../lib/notifications'
import type { AppNotification } from '../types'

// One page, mounted at /notifications (inside the customer shell) and at
// /admin/notifications (inside the admin shell). What differs is the framing the
// shell expects and what an empty list should say. Typed as a Record so a third
// audience cannot be added without deciding both.
const VIEW: Record<NotificationAudience, { page: string; heading: string; empty: string }> = {
  // The customer shell stretches its page to a framed, centred phone-width column.
  customer: {
    page: 'max-w-md mx-auto px-4 py-4 space-y-4 pb-28 app-frame',
    heading: 'text-xl',
    empty: "You'll hear from us here when one of your top-ups is reviewed.",
  },
  // The admin shell supplies its own surface and bottom padding, and its pages
  // are left-aligned blocks of the same width and heading size as Top-ups.
  admin: {
    page: 'p-4 md:p-8 space-y-4 max-w-3xl',
    heading: 'text-2xl',
    empty: 'New registrations, top-ups and orders waiting for your review will show up here.',
  },
}

export default function Notifications({ audience }: { audience: NotificationAudience }) {
  const { items: all, markAudienceRead, reload } = useNotifications()
  const view = VIEW[audience]
  // Everything below (what is listed, what counts as unseen, what gets marked
  // read) works from this one filtered list, so the page never marks or shows a
  // row from the other audience.
  const items = useMemo(() => inAudience(all, audience), [all, audience])

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
    void markAudienceRead(audience)
  }, [items, audience, markAudienceRead])

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
    <div className={view.page}>
      <h1 className={`font-display font-bold ${view.heading}`}>Alerts</h1>

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
          <p className="text-ink-700 text-sm">{view.empty}</p>
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
