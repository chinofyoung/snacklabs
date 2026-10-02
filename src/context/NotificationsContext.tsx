import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from './AuthContext'
import {
  PAGE, addNotification, countUnreadByAudience, inAudience, markRead, mergeFetched, unmarkRead,
  type NotificationAudience,
} from '../lib/notifications'
import type { AppNotification } from '../types'

interface NotificationsState {
  items: AppNotification[]
  // One count per audience and no total: each nav's badge must equal the number
  // of unread rows on the Alerts page it links to, and a total matches neither.
  unreadByAudience: Record<NotificationAudience, number>
  // Marks one audience's unread rows read and leaves the other's alone. There is
  // deliberately no "mark everything" form: visiting admin Alerts must not
  // quietly clear a person's own top-up alerts.
  markAudienceRead: (audience: NotificationAudience) => Promise<void>
  reload: () => Promise<void>
}

const NONE: AppNotification[] = []
const NO_UNREAD: Record<NotificationAudience, number> = { admin: 0, customer: 0 }

const NotificationsContext = createContext<NotificationsState>({
  items: NONE, unreadByAudience: NO_UNREAD, markAudienceRead: async () => {}, reload: async () => {},
})

// The list is stored with the person it belongs to. On a shared device the next
// account must never see the previous one's notifications — not for a render,
// not while its own fetch is in flight — so `items` is only exposed when the
// stored owner is the signed-in user.
interface Store {
  ownerId: string | null
  items: AppNotification[]
}

// supabase-js hands back the EXISTING channel for a topic that is still being
// removed, and a channel that is already subscribed refuses new `.on()` calls.
// A fixed name would hit that on StrictMode's mount/unmount/mount and on a
// sign-out/sign-in, so every subscription gets a topic of its own.
let channelSeq = 0

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth()
  // The id, not the session object: a token refresh hands back a new session
  // for the same person and must not tear the subscription down.
  const userId = session?.user.id ?? null
  const [store, setStore] = useState<Store>({ ownerId: null, items: NONE })

  // Who is signed in right now, readable from callbacks that outlive a render.
  const currentUser = useRef(userId)
  useEffect(() => { currentUser.current = userId }, [userId])

  // Every write to the list goes through here. An answer or an event for
  // someone who has since signed out is dropped instead of landing in the next
  // person's list.
  const apply = useCallback((forUser: string, update: (list: AppNotification[]) => AppNotification[]) => {
    if (currentUser.current !== forUser) return
    setStore((s) => ({ ownerId: forUser, items: update(s.ownerId === forUser ? s.items : NONE) }))
  }, [])

  const reload = useCallback(async () => {
    if (!userId) { setStore({ ownerId: null, items: NONE }); return }
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(PAGE)
    if (error) return // leave the last known list rather than blanking the badge
    apply(userId, (held) => mergeFetched(held, (data as AppNotification[]) ?? []))
  }, [userId, apply])

  useEffect(() => { void reload() }, [reload])

  // Realtime is the half that needs no permission, no service worker and no
  // particular OS version — it is why a dropped push is a delayed notification
  // rather than a lost one.
  useEffect(() => {
    if (!userId) return
    const channel = supabase
      .channel(`notifications:${userId}:${++channelSeq}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` },
        (payload) => apply(userId, (held) => addNotification(held, payload.new as AppNotification)),
      )
      // A dropped socket must not leave a permanently stale badge. realtime-js
      // rejoins the channel by itself after a reconnect and reports SUBSCRIBED
      // again each time (CHANNEL_ERROR in between), so this refetch runs on
      // every reconnect, not just the first subscribe.
      .subscribe((status) => { if (status === 'SUBSCRIBED') void reload() })
    return () => { void supabase.removeChannel(channel) }
  }, [userId, reload, apply])

  const markAudienceRead = useCallback(async (audience: NotificationAudience) => {
    if (!userId) return
    const unreadIds = inAudience(ownItems(store, userId), audience).filter((n) => !n.read_at).map((n) => n.id)
    if (!unreadIds.length) return
    const ids = new Set(unreadIds)
    const now = new Date().toISOString()
    apply(userId, (held) => markRead(held, ids, now))

    // The write is scoped to the ids shown as unread and to rows still unread,
    // and touches read_at alone — the only column the table lets a person
    // update. A thrown fetch is a failure too.
    let failed: boolean
    try {
      const { error } = await supabase
        .from('notifications')
        .update({ read_at: now })
        .in('id', unreadIds)
        .is('read_at', null)
      failed = error !== null
    } catch {
      failed = true
    }

    if (failed) {
      // Undo our own mark first: the refetch below fails too when the cause is
      // the network, and the badge must not stay cleared for rows the server
      // still has as unread.
      apply(userId, (held) => unmarkRead(held, ids, now))
      void reload()
    }
  }, [store, userId, apply, reload])

  const value = useMemo<NotificationsState>(() => {
    const mine = ownItems(store, userId)
    return { items: mine, unreadByAudience: countUnreadByAudience(mine), markAudienceRead, reload }
  }, [store, userId, markAudienceRead, reload])

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>
}

function ownItems(store: Store, userId: string | null): AppNotification[] {
  return userId !== null && store.ownerId === userId ? store.items : NONE
}

// eslint-disable-next-line react-refresh/only-export-components
export function useNotifications() {
  return useContext(NotificationsContext)
}
