import { NavLink, Outlet, Link } from 'react-router'
import { ArrowLeft, CupSoda, LayoutDashboard, ReceiptText, Settings, Store, TrendingUp, Users } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import CookieMark from '../../components/CookieMark'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  end: boolean
  // Keeps a section out of the space-constrained mobile bottom bar
  // (already at its width budget) while still showing it in the desktop sidebar.
  mobileHidden?: boolean
}

const NAV: NavItem[] = [
  { to: '/admin', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/admin/sales', label: 'Sales', icon: TrendingUp, end: false, mobileHidden: true },
  { to: '/admin/items', label: 'Items', icon: CupSoda, end: false },
  { to: '/admin/orders', label: 'Orders', icon: ReceiptText, end: false },
  { to: '/admin/users', label: 'Users', icon: Users, end: false },
  { to: '/admin/settings', label: 'Settings', icon: Settings, end: false },
]

export default function AdminLayout() {
  return (
    <div className="min-h-dvh md:flex bg-surface">
      <aside className="hidden md:flex md:flex-col w-56 shrink-0 border-r border-line bg-surface-raised p-4 gap-1">
        <Link to="/" className="font-display font-extrabold text-lg mb-4 rounded-md flex items-center gap-1.5">
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
        <Link
          to="/"
          className="mt-auto rounded-md px-3 py-2.5 text-sm font-medium transition flex items-center gap-2 text-ink-500 hover:bg-ink-900/5"
        >
          <ArrowLeft className="size-6" strokeWidth={2.5} aria-hidden="true" />
          Back to store
        </Link>
      </aside>

      <main className="grow pb-24 md:pb-8">
        <Outlet />
      </main>

      <nav className="md:hidden fixed bottom-0 inset-x-0 bg-surface-raised border-t border-line flex justify-around py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <Link
          to="/"
          className="flex flex-col items-center gap-0.5 text-[10px] px-2 py-1 rounded-md min-w-11 text-ink-500"
        >
          <Store className="size-6" strokeWidth={2.5} aria-hidden="true" />
          Store
        </Link>
        {NAV.filter((n) => !n.mobileHidden).map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) =>
              `flex flex-col items-center gap-0.5 text-[10px] px-2 py-1 rounded-md min-w-11 ${
                isActive ? 'text-brand-600 font-bold' : 'text-ink-500'
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
