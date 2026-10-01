import { NavLink, Outlet, Link } from 'react-router'
import { CupSoda, LayoutDashboard, ReceiptText, Settings, Store, TrendingUp, Users, Wallet } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import CookieMark from '../../components/CookieMark'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  end: boolean
  // Keeps a section out of the mobile bottom bar while still showing it in the
  // desktop sidebar. The bar was at its width budget; dropping its Store tab (the
  // header's Visit store link replaced it) freed one slot, which is deliberately
  // left empty. Top-ups stays hidden: admins reach it from the Dashboard tile.
  mobileHidden?: boolean
}

const NAV: NavItem[] = [
  { to: '/admin', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/admin/sales', label: 'Sales', icon: TrendingUp, end: false, mobileHidden: true },
  { to: '/admin/orders', label: 'Orders', icon: ReceiptText, end: false },
  { to: '/admin/topups', label: 'Top-ups', icon: Wallet, end: false, mobileHidden: true },
  { to: '/admin/items', label: 'Items', icon: CupSoda, end: false },
  { to: '/admin/users', label: 'Users', icon: Users, end: false },
  { to: '/admin/settings', label: 'Settings', icon: Settings, end: false },
]

export default function AdminLayout() {
  return (
    <div className="min-h-dvh md:flex bg-surface">
      <aside className="hidden md:flex md:flex-col w-56 shrink-0 border-r border-line bg-surface-raised p-4 gap-1">
        <Link to="/store" className="font-display font-extrabold text-lg mb-4 rounded-md flex items-center gap-1.5">
          <CookieMark className="size-6 text-brand-600" />
          SnackLabs
        </Link>
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) =>
              `rounded-md px-3 py-2.5 text-sm font-medium transition flex items-center gap-2 ${
                isActive ? 'bg-ink-900 text-white' : 'text-ink-500 hover:bg-ink-900/5'
              }`
            }
          >
            <n.icon className="size-6" strokeWidth={2.5} aria-hidden="true" />
            {n.label}
          </NavLink>
        ))}
      </aside>

      {/* min-w-0: as a flex item, this column otherwise refuses to shrink below
          the min-content width of its page, so one long nowrap/truncated line (a
          requester's email on Top-ups) pushes the whole page past the viewport
          next to the sidebar. */}
      <div className="grow min-w-0 flex flex-col">
        <header className="border-b border-line bg-surface-raised px-2 md:px-6 flex justify-end">
          <Link
            to="/store"
            className="min-h-11 px-2 inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-ink-700"
          >
            <Store className="size-5" strokeWidth={2.5} aria-hidden="true" />
            Visit store
          </Link>
        </header>
        <main className="grow pb-24 md:pb-8">
          <Outlet />
        </main>
      </div>

      <nav className="md:hidden fixed bottom-0 inset-x-0 bg-surface-raised border-t border-line flex justify-around py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {NAV.filter((n) => !n.mobileHidden).map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) =>
              `flex flex-col items-center gap-0.5 text-[10px] px-2 py-1 rounded-md min-w-11 ${
                isActive ? 'text-brand-700 font-bold' : 'text-ink-500'
              }`
            }
          >
            <n.icon className="size-6" strokeWidth={2.5} aria-hidden="true" />
            {n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
