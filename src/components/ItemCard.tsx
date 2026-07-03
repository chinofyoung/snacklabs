import { ShoppingBasket } from 'lucide-react'
import type { Item } from '../types'
import { formatPeso } from '../lib/money'
import { useCart } from '../context/CartContext'

export default function ItemCard({ item }: { item: Item }) {
  const { add, lines } = useCart()
  const inCart = lines.find((l) => l.item.id === item.id)?.qty ?? 0
  const out = item.stock <= 0
  const maxed = inCart >= item.stock

  return (
    <div className={`rounded-lg bg-surface-raised shadow-card overflow-hidden flex flex-col transition ${out ? 'opacity-45 grayscale-[40%]' : ''}`}>
      <div className="aspect-square bg-brand-50 flex items-center justify-center relative">
        {item.image_url
          ? <img src={item.image_url} alt={item.name} className="w-full h-full object-cover" />
          : <ShoppingBasket className="size-10 text-brand-600/40" strokeWidth={2.5} aria-hidden="true" />}
        {out && (
          <span className="absolute top-2 left-2 rounded-full bg-ink-900/80 text-white text-[10px] font-semibold px-2 py-0.5">
            Out of stock
          </span>
        )}
      </div>
      <div className="p-3 flex flex-col gap-1 grow">
        <p className="font-medium text-sm leading-tight">{item.name}</p>
        <p className="text-brand-600 font-bold tabular-nums">{formatPeso(item.price)}</p>
        {!out && (
          <p className={`text-xs ${item.stock <= item.low_stock_threshold ? 'text-amber-600 font-medium' : 'text-ink-500'}`}>
            {item.stock} left
          </p>
        )}
        <button
          disabled={out || maxed}
          onClick={() => add(item)}
          className="mt-auto rounded-md bg-ink-900 text-white text-sm py-2 font-medium disabled:bg-ink-400/40 disabled:text-ink-500 active:scale-95 transition"
        >
          {inCart > 0 ? `In cart · ${inCart}` : 'Add'}
        </button>
      </div>
    </div>
  )
}
