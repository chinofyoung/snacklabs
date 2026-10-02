import type { LucideIcon } from 'lucide-react'

// The icon of a navigation item, with an unread count pinned to its corner when
// `badge` is above zero. Shared by the customer tab bar and both admin
// navigations so Alerts looks identical wherever it appears. The count is
// aria-hidden: the link carries it in its accessible name (see unreadLabel).
//
// brand-700, not brand-600: white on brand-600 is 3.33:1, under the 4.5:1 that
// 10px text needs; brand-700 is 4.81:1.
export default function NavItemIcon({ icon: Icon, badge = 0 }: { icon: LucideIcon; badge?: number }) {
  return (
    <span className="relative">
      <Icon className="size-6" strokeWidth={2.5} aria-hidden="true" />
      {badge > 0 && (
        <span
          aria-hidden="true"
          className="absolute -top-1 -right-1.5 min-w-4 h-4 px-1 rounded-full bg-brand-700 text-white text-[10px] font-bold flex items-center justify-center tabular-nums"
        >
          {badge > 9 ? '9+' : badge}
        </span>
      )}
    </span>
  )
}
