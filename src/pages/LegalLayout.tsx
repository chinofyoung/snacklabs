import { Link } from 'react-router'
import type { ReactNode } from 'react'
import CookieMark from '../components/CookieMark'

interface LegalLayoutProps {
  title: string
  lastUpdated: string
  otherDocHref: string
  otherDocLabel: string
  children: ReactNode
}

// Shared chrome for the two public legal documents (Privacy, Terms). Extracted
// rather than duplicated so the header/footer and typography stay identical
// if the design tokens ever change — these two pages are meant to look and
// read as one pair, not as independent one-offs.
export default function LegalLayout({ title, lastUpdated, otherDocHref, otherDocLabel, children }: LegalLayoutProps) {
  return (
    <div className="app-frame max-w-2xl mx-auto min-h-dvh px-4 py-8 space-y-6">
      <header>
        <Link to="/" className="font-display text-lg font-extrabold flex items-center gap-1.5 text-ink-900 w-fit">
          <CookieMark className="size-6 text-brand-600" />
          SnackLabs
        </Link>
      </header>

      <div className="space-y-6">
        <div>
          <h1 className="font-display text-2xl font-bold">{title}</h1>
          <p className="text-xs text-ink-500 mt-1">Last updated {lastUpdated}</p>
        </div>

        {children}
      </div>

      <footer className="pt-4 border-t border-line text-xs text-ink-500 flex items-center gap-4">
        <Link to={otherDocHref} className="underline hover:text-ink-700">
          {otherDocLabel}
        </Link>
        <Link to="/" className="underline hover:text-ink-700">
          Back to SnackLabs
        </Link>
      </footer>
    </div>
  )
}
