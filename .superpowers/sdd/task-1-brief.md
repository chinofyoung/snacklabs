### Task 1: Project scaffold (Vite + Tailwind v4 + Vitest + Supabase client)

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig*.json`, `index.html`, `src/main.tsx`, `src/App.tsx` (via Vite scaffold)
- Create: `src/index.css`, `src/lib/supabase.ts`, `src/lib/money.ts`, `.env.local`, `.env.example`
- Test: `src/lib/money.test.ts`

**Interfaces:**
- Produces: `supabase` (typed `SupabaseClient` singleton from `src/lib/supabase.ts`), `formatPeso(amount: number): string` from `src/lib/money.ts`. Every later task imports these.

- [ ] **Step 1: Scaffold the app**

```bash
cd /Users/chinoyoung/snacklabs
npm create vite@latest . -- --template react-ts
npm install
npm install tailwindcss @tailwindcss/vite react-router @supabase/supabase-js
npm install -D vitest
```

If `npm create vite` refuses because the directory is non-empty (it contains `docs/`), run it with the "Ignore files and continue" option, or scaffold into a temp dir and move the generated files in — `docs/` must be preserved.

- [ ] **Step 2: Configure Vite (Tailwind v4 plugin) and Vitest**

Replace `vite.config.ts`:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    include: ['src/**/*.test.ts', 'supabase/functions/_shared/**/*.test.ts'],
  },
})
```

Add to the top of the file if TS complains about `test`: `/// <reference types="vitest/config" />`.

Add to `package.json` scripts: `"test": "vitest run"`.

Replace `src/index.css` entirely:

```css
@import "tailwindcss";

@theme {
  --color-brand-50: #fff7ed;
  --color-brand-500: #f97316;
  --color-brand-600: #ea580c;
  --color-ink-900: #1c1917;
  --color-ink-500: #78716c;
  --color-surface: #fafaf9;
}

body {
  background: var(--color-surface);
  color: var(--color-ink-900);
}
```

Delete `src/App.css` and remove its import from `src/App.tsx`.

- [ ] **Step 3: Env + Supabase client**

`.env.local` (and `.env.example` with empty values):

```
VITE_SUPABASE_URL=<project url>
VITE_SUPABASE_ANON_KEY=<anon key>
```

`src/lib/supabase.ts`:

```ts
import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
)
```

- [ ] **Step 4: Write the failing money test**

`src/lib/money.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { formatPeso } from './money'

describe('formatPeso', () => {
  it('formats whole pesos with two decimals', () => {
    expect(formatPeso(15)).toBe('₱15.00')
  })
  it('formats thousands with grouping', () => {
    expect(formatPeso(1234.5)).toBe('₱1,234.50')
  })
})
```

- [ ] **Step 5: Run test to verify it fails**

Run: `npm run test`
Expected: FAIL — `Cannot find module './money'` (or similar).

- [ ] **Step 6: Implement `src/lib/money.ts`**

```ts
const fmt = new Intl.NumberFormat('en-PH', {
  style: 'currency',
  currency: 'PHP',
  minimumFractionDigits: 2,
})

export function formatPeso(amount: number): string {
  return fmt.format(amount)
}
```

- [ ] **Step 7: Verify tests pass and build works**

Run: `npm run test` → PASS (2 tests). Run: `npm run build` → succeeds.

---

