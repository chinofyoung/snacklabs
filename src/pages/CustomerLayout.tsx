import { Link, NavLink, Outlet } from 'react-router'
import { Bell, LayoutDashboard, ReceiptText, Settings, Store, Wallet } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import NavItemIcon from '../components/NavItemIcon'
import { useNotifications } from '../context/NotificationsContext'
import { unreadLabel } from '../lib/notifications'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  end: boolean
  // Renders the unread notification count on this item.
  showsUnread?: boolean
}

const NAV: NavItem[] = [
  { to: '/store', label: 'Store', icon: Store, end: false },
  { to: '/orders', label: 'My orders', icon: ReceiptText, end: false },
  { to: '/wallet', label: 'Top up', icon: Wallet, end: false },
  { to: '/notifications', label: 'Alerts', icon: Bell, end: false, showsUnread: true },
  { to: '/settings', label: 'Settings', icon: Settings, end: false },
]

export default function CustomerLayout() {
  const { profile } = useAuth()
  const unread = useNotifications().unreadByAudience.customer

  return (
    <div className="min-h-dvh flex flex-col bg-surface">
      {/* Admins only, and not rendered at all otherwise: an empty header would sit
          in the accessibility tree and push every customer's content down. It lives
          in the shell so all four tabs carry it, and it uses the same max-w-md
          column as the content and the bottom nav so it lines up on desktop. */}
      {profile?.is_admin && (
        <header className="bg-surface-raised border-b border-line">
          <div className="max-w-md mx-auto px-2 flex justify-end">
            <Link
              to="/admin"
              className="min-h-11 px-2 inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-ink-700"
            >
              <LayoutDashboard className="size-5" strokeWidth={2.5} aria-hidden="true" />
              Admin
            </Link>
          </div>
        </header>
      )}
      {/* The shell, not each page, owns the full-height rule: the header takes its
          natural height and <main> grows into whatever is left, so the document is
          exactly one viewport tall for admins and non-admins alike. Pages are
          stretched to fill main (and to the full width their own max-w-md/mx-auto
          then centres) so their framed column runs the full height on desktop. Pages
          must therefore NOT set min-h-dvh themselves.

          Two rules a page here has to keep, because `*:` reaches EVERY direct child
          of <main>: render a SINGLE root element, and do not rely on a width utility
          of your own at that root. A fragment with two roots would split the height
          between them and give both w-full — which breaks a `fixed` sibling like
          CartBar (fixed inset-x-4 max-w-[26rem] mx-auto): w-full over-constrains it
          against both insets and it runs off the right edge on a phone. */}
      <main className="grow flex flex-col *:grow *:w-full">
        <Outlet />
      </main>

      {/* Unlike AdminLayout's bar this is not md:hidden: the customer side is
          mobile-first at every width, so the tabs stay put on desktop and are
          constrained to the same max-w-md column as the content. */}
      <nav aria-label="Primary" className="fixed bottom-0 inset-x-0 z-20 bg-surface-raised border-t border-line">
        <div className="max-w-md mx-auto flex justify-around py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              aria-label={n.showsUnread ? unreadLabel(n.label, unread) : undefined}
              className={({ isActive }) =>
                `flex flex-col items-center gap-0.5 text-[10px] px-2 py-1 rounded-md min-w-11 ${
                  isActive ? 'text-brand-700 font-bold' : 'text-ink-500'
                }`
              }
            >
              <NavItemIcon icon={n.icon} badge={n.showsUnread ? unread : 0} />
              {n.label}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  )
}
