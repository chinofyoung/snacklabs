import { NavLink, Outlet } from 'react-router'
import { ReceiptText, Settings, Store, Wallet } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  end: boolean
}

const NAV: NavItem[] = [
  { to: '/store', label: 'Store', icon: Store, end: false },
  { to: '/orders', label: 'My orders', icon: ReceiptText, end: false },
  { to: '/wallet', label: 'Top up', icon: Wallet, end: false },
  { to: '/settings', label: 'Settings', icon: Settings, end: false },
]

export default function CustomerLayout() {
  return (
    <div className="min-h-dvh bg-surface">
      <main>
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
        </div>
      </nav>
    </div>
  )
}
