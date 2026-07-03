# Task 18: Auto-return countdown on PAID state

## File changed
`src/pages/Pay.tsx` (only file touched)

## Exact additions

### 1. Import (line 2)
```tsx
import { Link, useParams, useNavigate } from 'react-router'
```

### 2. New state/hook declarations in `Pay()`
```tsx
const navigate = useNavigate()
...
const [countdown, setCountdown] = useState(10)
```

### 3. New effect (placed after the existing data-fetch effect, before `if (!order) return ...`)
```tsx
useEffect(() => {
  if (order?.status !== 'paid') return
  if (countdown <= 0) {
    navigate('/')
    return
  }
  const t = setTimeout(() => setCountdown((c) => c - 1), 1000)
  return () => clearTimeout(t)
}, [order?.status, countdown, navigate])
```

### 4. JSX addition below the existing "Back to store" terminal-state block
```tsx
{order.status === 'paid' && (
  <p className="text-center text-sm text-ink-500">Returning to store in {countdown}…</p>
)}
```

No other lines were modified. `PaymentStatus`, the back button, and fetch logic are unchanged. All hooks remain above the early `if (!order) return ...`.

## Gate results

- `npm run test`: **16/16 passed** (4 test files, 143ms)
- `npm run build`: **clean** — `tsc -b && vite build` succeeded, produced `dist/` output with no errors or warnings.
