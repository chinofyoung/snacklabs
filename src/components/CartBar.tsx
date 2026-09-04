import { Link } from 'react-router'
import { useCart } from '../context/CartContext'
import { formatPeso } from '../lib/money'

export default function CartBar() {
  const { count, total } = useCart()
  if (count === 0) return null
  return (
    <Link
      to="/cart"
      className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] inset-x-4 max-w-[26rem] mx-auto rounded-lg bg-brand-600 text-white px-5 py-3.5 flex items-center justify-between shadow-float active:scale-[0.98] transition"
    >
      <span className="font-medium">{count} item{count > 1 ? 's' : ''}</span>
      <span className="font-bold tabular-nums">{formatPeso(total)} · View cart →</span>
    </Link>
  )
}
