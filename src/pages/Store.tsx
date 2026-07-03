import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { PackageOpen, Popcorn, Search } from 'lucide-react'
import { supabase } from '../lib/supabase'
import type { Item } from '../types'
import ItemCard from '../components/ItemCard'
import CartBar from '../components/CartBar'
import { useAuth } from '../context/AuthContext'

export default function Store() {
  const { profile, signOut } = useAuth()
  const [items, setItems] = useState<Item[]>([])
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    supabase.from('items').select('*').eq('is_active', true).order('name')
      .then(({ data, error }) => {
        if (error) {
          setError('Could not load the shelf — pull to refresh or try again.')
        } else {
          setItems((data as Item[]) ?? [])
        }
        setLoading(false)
      })
  }, [])

  const categories = useMemo(
    () => [...new Set(items.map((i) => i.category))].sort(),
    [items],
  )
  const visible = items.filter((i) =>
    (!category || i.category === category) &&
    i.name.toLowerCase().includes(search.toLowerCase()),
  )

  return (
    <div className="max-w-md mx-auto min-h-dvh pb-28">
      <header className="sticky top-0 z-10 bg-surface/90 backdrop-blur px-4 pt-4 pb-3 space-y-3 border-b border-line">
        <div className="flex items-center justify-between">
          <h1 className="font-display text-xl font-extrabold flex items-center gap-1.5">
            <Popcorn className="size-6 text-brand-600" strokeWidth={2.5} aria-hidden="true" />
            SnackLabs
          </h1>
          <div className="flex items-center gap-4 text-sm">
            <Link to="/orders" className="text-ink-500 rounded-md">My orders</Link>
            {profile?.is_admin && <Link to="/admin" className="text-brand-600 font-semibold rounded-md">Admin</Link>}
            <button onClick={signOut} className="text-ink-500 rounded-md">Sign out</button>
          </div>
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search snacks…"
          className="w-full rounded-xl bg-surface-raised px-4 py-2.5 text-sm shadow-card outline-none focus-visible:outline-2 focus-visible:outline-brand-500"
        />
        <div className="flex gap-2 overflow-x-auto pb-1">
          <Chip active={!category} onClick={() => setCategory(null)}>All</Chip>
          {categories.map((c) => (
            <Chip key={c} active={category === c} onClick={() => setCategory(c)}>{c}</Chip>
          ))}
        </div>
      </header>

      {loading ? (
        <p className="p-8 text-center text-ink-500">Loading the shelf…</p>
      ) : error ? (
        <p className="p-8 text-center text-red-600">{error}</p>
      ) : visible.length === 0 ? (
        <div className="p-10 text-center space-y-2 flex flex-col items-center">
          {items.length === 0
            ? <PackageOpen className="size-12 text-ink-500" strokeWidth={2.5} aria-hidden="true" />
            : <Search className="size-12 text-ink-500" strokeWidth={2.5} aria-hidden="true" />}
          {items.length === 0 ? (
            <>
              <p className="text-ink-700 font-medium">The shelf is empty</p>
              <p className="text-ink-500 text-sm">Check back once it's restocked.</p>
            </>
          ) : (
            <>
              <p className="text-ink-700 font-medium">Nothing matches{search ? ` "${search}"` : ''}</p>
              <p className="text-ink-500 text-sm">Try a different search or clear the filter.</p>
            </>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 px-4 pt-3">
          {visible.map((i) => <ItemCard key={i.id} item={i} />)}
        </div>
      )}
      <CartBar />
    </div>
  )
}

function Chip({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium capitalize transition ${
        active ? 'bg-ink-900 text-white' : 'bg-surface-raised text-ink-500 shadow-card'
      }`}
    >
      {children}
    </button>
  )
}
