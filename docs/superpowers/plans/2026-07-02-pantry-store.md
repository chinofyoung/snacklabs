# SnackLabs Pantry Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mobile-first office pantry store — customers browse items and pay via QR with AI-verified payment screenshots; admins manage inventory (including AI photo restock) and payment methods.

**Architecture:** Single Vite + React + TypeScript SPA with two route trees (`/` customer, `/admin`). Supabase provides Google OAuth (domain-restricted), Postgres with RLS, image storage, and two Deno Edge Functions (`verify-payment`, `analyze-shelf`) that call the Anthropic API server-side. Stock changes only happen inside Postgres functions (transactions).

**Tech Stack:** Vite 6, React 18+, TypeScript, Tailwind CSS v4 (`@tailwindcss/vite`), react-router v7 (library mode), `@supabase/supabase-js` v2, Vitest, Anthropic TypeScript SDK (`npm:@anthropic-ai/sdk` in Deno), model `claude-opus-4-8`.

**Spec:** `docs/superpowers/specs/2026-07-02-pantry-store-design.md`

## Global Constraints

- **NO git commands.** Do not run any state-changing git command (no `git init`, `add`, `commit`, etc.). The user handles version control. Task steps therefore have no commit steps.
- **Anthropic model:** `claude-opus-4-8`, exactly this string, in both Edge Functions. Structured output via `output_config: { format: { type: "json_schema", schema: ... } }`. The API key lives ONLY in Supabase Edge Function secrets (`ANTHROPIC_API_KEY`), never in frontend code or `.env` files that ship to the browser.
- **Currency:** Philippine Pesos. All money displayed via `formatPeso()` from `src/lib/money.ts`. Prices stored as `numeric(10,2)` in Postgres, plain `number` in TS.
- **Auth domain:** only `@goabroad.com` emails may create profiles (enforced by DB trigger).
- **Stock integrity:** the client NEVER writes `items.stock` or `orders.status` directly for purchases. Stock decrement happens only in the `confirm_order` Postgres function; restock only in `apply_restock`.
- **Screenshots:** if any task saves screenshots, save them under `docs/screenshots/` (create the directory if missing), never the project root.
- **Order status flow:** `awaiting_payment → verifying → paid | needs_review | cancelled`. String literals exactly as written.
- Run `npm run test` (Vitest) and `npm run build` (tsc + vite) as the verification gate for every frontend task.

## Prerequisites (user-provided, before Task 2)

The implementer needs these from the user / environment. If missing, STOP and ask:

1. A Supabase project (hosted). Values needed: project URL, anon key — for `.env.local`; the project must be linked via `supabase link --project-ref <ref>` (Supabase CLI) so `supabase db push` and `supabase functions deploy` work. If the CLI isn't installed: `brew install supabase/tap/supabase`.
2. Google OAuth enabled in Supabase Dashboard → Authentication → Providers → Google (user does this in the dashboard; the plan does not automate it).
3. An Anthropic API key set as an Edge Function secret: `supabase secrets set ANTHROPIC_API_KEY=<key>`.

---

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

### Task 2: Database schema, RLS, functions, storage buckets

**Files:**
- Create: `supabase/migrations/00001_init.sql` (run `supabase init` first if `supabase/` doesn't exist)

**Interfaces:**
- Produces (used by all later tasks):
  - Tables: `profiles`, `items`, `payment_methods`, `orders`, `order_items`, `restock_sessions` (columns below).
  - `public.is_admin() returns boolean`
  - `public.create_order(p_items jsonb, p_payment_method_id uuid) returns uuid` — `p_items` is `[{"item_id": "<uuid>", "qty": <int>}]`; validates stock, snapshots prices, returns the new order id with status `awaiting_payment`.
  - `public.confirm_order(p_order_id uuid, p_verdict jsonb) returns void` — decrements stock + sets `paid`; callable only by service role or admins.
  - `public.apply_restock(p_session_id uuid, p_lines jsonb) returns void` — `p_lines` is `[{"item_id": "<uuid>"|null, "name": str, "price": num, "qty": int, "category": str}]`; admin only.
  - Storage buckets: `item-images` (public), `qr-codes` (public), `receipts` (private), `restock-photos` (private).

- [ ] **Step 1: Init supabase dir and create the migration**

```bash
supabase init   # skip if supabase/config.toml exists
supabase migration new init
```

Write the generated file (rename content target: `supabase/migrations/*_init.sql`) with exactly:

```sql
-- ===== Tables =====
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text not null default '',
  avatar_url text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  price numeric(10,2) not null check (price >= 0),
  stock integer not null default 0 check (stock >= 0),
  image_url text,
  category text not null default 'snacks',
  low_stock_threshold integer not null default 3,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.payment_methods (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  type text not null check (type in ('ewallet','bank')),
  qr_image_url text not null,
  account_name text not null,
  account_number text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  total numeric(10,2) not null default 0,
  status text not null default 'awaiting_payment'
    check (status in ('awaiting_payment','verifying','paid','needs_review','cancelled')),
  payment_method_id uuid references public.payment_methods(id),
  receipt_image_url text,
  ai_verdict jsonb,
  created_at timestamptz not null default now()
);

create table public.order_items (
  order_id uuid not null references public.orders(id) on delete cascade,
  item_id uuid not null references public.items(id),
  qty integer not null check (qty > 0),
  price_at_purchase numeric(10,2) not null,
  primary key (order_id, item_id)
);

create table public.restock_sessions (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references public.profiles(id),
  photo_url text not null,
  ai_result jsonb,
  status text not null default 'pending_review'
    check (status in ('pending_review','applied','discarded')),
  created_at timestamptz not null default now()
);

-- ===== Auth: profile creation + domain restriction =====
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.email is null or new.email not ilike '%@goabroad.com' then
    raise exception 'Only goabroad.com accounts may sign in';
  end if;
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    new.raw_user_meta_data->>'avatar_url'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ===== Helper =====
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false)
$$;

-- ===== RLS =====
alter table public.profiles enable row level security;
alter table public.items enable row level security;
alter table public.payment_methods enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.restock_sessions enable row level security;

create policy "profiles read all" on public.profiles for select to authenticated using (true);
create policy "profiles admin update" on public.profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "items read" on public.items for select to authenticated using (true);
create policy "items admin write" on public.items for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "pm read" on public.payment_methods for select to authenticated using (true);
create policy "pm admin write" on public.payment_methods for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "orders read own or admin" on public.orders for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
create policy "orders admin update" on public.orders for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
-- inserts happen only via create_order() (security definer); no insert policy needed.

create policy "order_items read" on public.order_items for select to authenticated
  using (exists (
    select 1 from public.orders o
    where o.id = order_id and (o.user_id = auth.uid() or public.is_admin())
  ));

create policy "restock admin all" on public.restock_sessions for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ===== create_order =====
create or replace function public.create_order(p_items jsonb, p_payment_method_id uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_order_id uuid;
  v_total numeric(10,2) := 0;
  r record;
  v_price numeric(10,2);
  v_stock integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if jsonb_array_length(p_items) = 0 then
    raise exception 'empty order';
  end if;

  insert into public.orders (user_id, total, status, payment_method_id)
  values (auth.uid(), 0, 'awaiting_payment', p_payment_method_id)
  returning id into v_order_id;

  for r in
    select (e->>'item_id')::uuid as item_id, (e->>'qty')::int as qty
    from jsonb_array_elements(p_items) e
  loop
    if r.qty is null or r.qty <= 0 then
      raise exception 'invalid quantity';
    end if;
    select price, stock into v_price, v_stock
    from public.items where id = r.item_id and is_active for update;
    if not found then
      raise exception 'item % not found', r.item_id;
    end if;
    if v_stock < r.qty then
      raise exception 'insufficient stock: %', r.item_id;
    end if;
    insert into public.order_items (order_id, item_id, qty, price_at_purchase)
    values (v_order_id, r.item_id, r.qty, v_price);
    v_total := v_total + v_price * r.qty;
  end loop;

  update public.orders set total = v_total where id = v_order_id;
  return v_order_id;
end;
$$;

-- ===== confirm_order (service role / admin only) =====
create or replace function public.confirm_order(p_order_id uuid, p_verdict jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  r record;
  v_status text;
begin
  if not (public.is_admin() or auth.role() = 'service_role') then
    raise exception 'forbidden';
  end if;

  select status into v_status from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order not found';
  end if;
  if v_status not in ('awaiting_payment','verifying','needs_review') then
    raise exception 'order not confirmable (status %)', v_status;
  end if;

  for r in select item_id, qty from public.order_items where order_id = p_order_id loop
    update public.items set stock = stock - r.qty
    where id = r.item_id and stock >= r.qty;
    if not found then
      raise exception 'insufficient stock at confirmation';
    end if;
  end loop;

  update public.orders
  set status = 'paid', ai_verdict = coalesce(p_verdict, ai_verdict)
  where id = p_order_id;
end;
$$;

-- ===== apply_restock (admin only) =====
create or replace function public.apply_restock(p_session_id uuid, p_lines jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  r record;
begin
  if not public.is_admin() then
    raise exception 'forbidden';
  end if;

  for r in
    select
      nullif(e->>'item_id','')::uuid as item_id,
      e->>'name' as name,
      (e->>'price')::numeric(10,2) as price,
      (e->>'qty')::int as qty,
      coalesce(e->>'category','snacks') as category
    from jsonb_array_elements(p_lines) e
  loop
    if r.qty is null or r.qty <= 0 then continue; end if;
    if r.item_id is not null then
      update public.items set stock = stock + r.qty where id = r.item_id;
    else
      insert into public.items (name, price, stock, category)
      values (r.name, coalesce(r.price, 0), r.qty, r.category);
    end if;
  end loop;

  update public.restock_sessions set status = 'applied' where id = p_session_id;
end;
$$;

-- ===== Storage buckets =====
insert into storage.buckets (id, name, public) values
  ('item-images','item-images', true),
  ('qr-codes','qr-codes', true),
  ('receipts','receipts', false),
  ('restock-photos','restock-photos', false);

create policy "public buckets read" on storage.objects for select to authenticated
  using (bucket_id in ('item-images','qr-codes'));
create policy "admin write public buckets" on storage.objects for insert to authenticated
  with check (bucket_id in ('item-images','qr-codes') and public.is_admin());
create policy "admin update public buckets" on storage.objects for update to authenticated
  using (bucket_id in ('item-images','qr-codes') and public.is_admin());
create policy "admin delete public buckets" on storage.objects for delete to authenticated
  using (bucket_id in ('item-images','qr-codes') and public.is_admin());

create policy "receipts upload own" on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and owner = auth.uid());
create policy "receipts reupload own" on storage.objects for update to authenticated
  using (bucket_id = 'receipts' and owner = auth.uid())
  with check (bucket_id = 'receipts' and owner = auth.uid());
create policy "receipts read own or admin" on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and (owner = auth.uid() or public.is_admin()));

create policy "restock photos admin" on storage.objects for insert to authenticated
  with check (bucket_id = 'restock-photos' and public.is_admin());
create policy "restock photos admin read" on storage.objects for select to authenticated
  using (bucket_id = 'restock-photos' and public.is_admin());
```

- [ ] **Step 2: Apply the migration**

Run: `supabase db push`
Expected: migration applies cleanly. If the project isn't linked, STOP and ask the user to run `supabase link --project-ref <ref>` (or ask them to paste the SQL into the Dashboard SQL editor and confirm).

- [ ] **Step 3: Verify schema**

Run: `supabase db diff` (expected: no drift) or, via SQL editor:

```sql
select count(*) from public.items;                          -- 0, no error
select public.is_admin();                                    -- false (no auth), no error
select id, public from storage.buckets order by id;          -- 4 rows
```

- [ ] **Step 4: Remind the user (do not skip)**

Tell the user: after their first Google sign-in (Task 3 verification), run in the SQL editor:
`update public.profiles set is_admin = true where email = 'chino.young@goabroad.com';`

---

### Task 3: Auth — Google sign-in, AuthContext, route guards, app shell routing

**Files:**
- Create: `src/context/AuthContext.tsx`, `src/pages/Login.tsx`, `src/components/guards.tsx`
- Modify: `src/main.tsx`, `src/App.tsx`

**Interfaces:**
- Consumes: `supabase` from Task 1.
- Produces:
  - `useAuth(): { session: Session | null; profile: Profile | null; loading: boolean; signOut(): Promise<void> }` from `src/context/AuthContext.tsx`
  - `Profile` type: `{ id: string; email: string; full_name: string; avatar_url: string | null; is_admin: boolean }`
  - `<RequireAuth>` and `<RequireAdmin>` wrapper components from `src/components/guards.tsx`
  - Route structure in `App.tsx` that later tasks add routes into.

- [ ] **Step 1: AuthContext**

`src/context/AuthContext.tsx`:

```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

export interface Profile {
  id: string
  email: string
  full_name: string
  avatar_url: string | null
  is_admin: boolean
}

interface AuthState {
  session: Session | null
  profile: Profile | null
  loading: boolean
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState>({
  session: null, profile: null, loading: true, signOut: async () => {},
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      if (!data.session) setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s)
      if (!s) { setProfile(null); setLoading(false) }
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session) return
    supabase.from('profiles').select('*').eq('id', session.user.id).single()
      .then(({ data }) => {
        setProfile(data as Profile | null)
        setLoading(false)
      })
  }, [session])

  const signOut = async () => { await supabase.auth.signOut() }

  return (
    <AuthContext.Provider value={{ session, profile, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  return useContext(AuthContext)
}
```

- [ ] **Step 2: Login page**

`src/pages/Login.tsx`:

```tsx
import { supabase } from '../lib/supabase'

export default function Login() {
  const signIn = () =>
    supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    })

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center gap-8 px-6">
      <div className="text-center">
        <div className="text-5xl mb-3">🍿</div>
        <h1 className="text-2xl font-bold">SnackLabs</h1>
        <p className="text-ink-500 mt-1">The office pantry, in your pocket.</p>
      </div>
      <button
        onClick={signIn}
        className="w-full max-w-xs rounded-xl bg-ink-900 text-white py-3 font-medium active:scale-95 transition"
      >
        Continue with Google
      </button>
      <p className="text-xs text-ink-500">goabroad.com accounts only</p>
    </div>
  )
}
```

- [ ] **Step 3: Guards**

`src/components/guards.tsx`:

```tsx
import type { ReactNode } from 'react'
import { Navigate } from 'react-router'
import { useAuth } from '../context/AuthContext'

function Splash() {
  return <div className="min-h-dvh flex items-center justify-center text-ink-500">Loading…</div>
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth()
  if (loading) return <Splash />
  if (!session) return <Navigate to="/login" replace />
  return <>{children}</>
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { session, profile, loading } = useAuth()
  if (loading) return <Splash />
  if (!session) return <Navigate to="/login" replace />
  if (!profile?.is_admin) return <Navigate to="/" replace />
  return <>{children}</>
}
```

- [ ] **Step 4: Wire up routing**

`src/main.tsx`:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
import App from './App'
import { AuthProvider } from './context/AuthContext'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
```

`src/App.tsx` (placeholder pages get replaced by later tasks):

```tsx
import { Routes, Route } from 'react-router'
import Login from './pages/Login'
import { RequireAuth, RequireAdmin } from './components/guards'

const Placeholder = ({ name }: { name: string }) => (
  <div className="p-8 text-ink-500">{name} — coming soon</div>
)

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<RequireAuth><Placeholder name="Store" /></RequireAuth>} />
      <Route path="/admin/*" element={<RequireAdmin><Placeholder name="Admin" /></RequireAdmin>} />
    </Routes>
  )
}
```

- [ ] **Step 5: Verify**

Run: `npm run build` → succeeds. Run `npm run dev`, open the app: unauthenticated users land on `/login`; clicking "Continue with Google" redirects to Google. After the user signs in once, remind them to run the `is_admin` SQL from Task 2 Step 4. Verify a row exists: `select * from public.profiles;`.

---

### Task 4: Domain types + cart logic (TDD) + cart context

**Files:**
- Create: `src/types.ts`, `src/lib/cart.ts`, `src/context/CartContext.tsx`
- Test: `src/lib/cart.test.ts`

**Interfaces:**
- Produces:
  - `src/types.ts`: `Item`, `PaymentMethod`, `Order`, `OrderStatus`, `OrderItem`, `RestockSession`, `AiVerdict`, `CartLine` (shapes below — later tasks import these).
  - `src/lib/cart.ts`: `addToCart(lines, item)`, `setQty(lines, itemId, qty)` (qty ≤ 0 removes the line; qty clamped to item stock), `cartTotal(lines): number`, `cartCount(lines): number`. All pure, return new arrays.
  - `src/context/CartContext.tsx`: `useCart(): { lines: CartLine[]; add(item: Item): void; setLineQty(itemId: string, qty: number): void; clear(): void; total: number; count: number }`, persisted to `localStorage` key `snacklabs.cart`.

- [ ] **Step 1: Types**

`src/types.ts`:

```ts
export interface Item {
  id: string
  name: string
  price: number
  stock: number
  image_url: string | null
  category: string
  low_stock_threshold: number
  is_active: boolean
}

export interface PaymentMethod {
  id: string
  label: string
  type: 'ewallet' | 'bank'
  qr_image_url: string
  account_name: string
  account_number: string
  is_active: boolean
}

export type OrderStatus =
  | 'awaiting_payment' | 'verifying' | 'paid' | 'needs_review' | 'cancelled'

export interface AiVerdict {
  verdict: 'pass' | 'fail' | 'unsure'
  extracted: {
    amount: number | null
    recipient: string | null
    reference: string | null
    timestamp: string | null
  }
  reason: string
}

export interface Order {
  id: string
  user_id: string
  total: number
  status: OrderStatus
  payment_method_id: string | null
  receipt_image_url: string | null
  ai_verdict: AiVerdict | null
  created_at: string
}

export interface OrderItem {
  order_id: string
  item_id: string
  qty: number
  price_at_purchase: number
}

export interface RestockDetection {
  matched_item_id: string | null
  name: string
  qty: number
  suggested_price: number | null
  confidence: 'high' | 'medium' | 'low'
}

export interface RestockSession {
  id: string
  admin_id: string
  photo_url: string
  ai_result: { detections: RestockDetection[] } | null
  status: 'pending_review' | 'applied' | 'discarded'
  created_at: string
}

export interface CartLine {
  item: Item
  qty: number
}
```

- [ ] **Step 2: Write failing cart tests**

`src/lib/cart.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { addToCart, setQty, cartTotal, cartCount } from './cart'
import type { Item, CartLine } from '../types'

const item = (over: Partial<Item> = {}): Item => ({
  id: 'a', name: 'Piattos', price: 25, stock: 5, image_url: null,
  category: 'snacks', low_stock_threshold: 3, is_active: true, ...over,
})

describe('cart', () => {
  it('adds a new item with qty 1', () => {
    const lines = addToCart([], item())
    expect(lines).toEqual([{ item: item(), qty: 1 }])
  })

  it('increments qty when item already in cart', () => {
    const lines = addToCart([{ item: item(), qty: 1 }], item())
    expect(lines[0].qty).toBe(2)
  })

  it('does not exceed stock when adding', () => {
    const lines = addToCart([{ item: item({ stock: 2 }), qty: 2 }], item({ stock: 2 }))
    expect(lines[0].qty).toBe(2)
  })

  it('setQty clamps to stock and removes at zero', () => {
    const start: CartLine[] = [{ item: item({ stock: 3 }), qty: 1 }]
    expect(setQty(start, 'a', 10)[0].qty).toBe(3)
    expect(setQty(start, 'a', 0)).toEqual([])
  })

  it('computes total and count', () => {
    const lines: CartLine[] = [
      { item: item({ id: 'a', price: 25 }), qty: 2 },
      { item: item({ id: 'b', price: 10.5 }), qty: 1 },
    ]
    expect(cartTotal(lines)).toBe(60.5)
    expect(cartCount(lines)).toBe(3)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test` → FAIL: `Cannot find module './cart'`.

- [ ] **Step 4: Implement `src/lib/cart.ts`**

```ts
import type { CartLine, Item } from '../types'

export function addToCart(lines: CartLine[], item: Item): CartLine[] {
  const existing = lines.find((l) => l.item.id === item.id)
  if (!existing) return [...lines, { item, qty: 1 }]
  return setQty(lines, item.id, existing.qty + 1)
}

export function setQty(lines: CartLine[], itemId: string, qty: number): CartLine[] {
  if (qty <= 0) return lines.filter((l) => l.item.id !== itemId)
  return lines.map((l) =>
    l.item.id === itemId ? { ...l, qty: Math.min(qty, l.item.stock) } : l,
  )
}

export function cartTotal(lines: CartLine[]): number {
  return lines.reduce((sum, l) => sum + l.item.price * l.qty, 0)
}

export function cartCount(lines: CartLine[]): number {
  return lines.reduce((sum, l) => sum + l.qty, 0)
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test` → PASS (all cart + money tests).

- [ ] **Step 6: Cart context**

`src/context/CartContext.tsx`:

```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { CartLine, Item } from '../types'
import { addToCart, setQty, cartTotal, cartCount } from '../lib/cart'

interface CartState {
  lines: CartLine[]
  add: (item: Item) => void
  setLineQty: (itemId: string, qty: number) => void
  clear: () => void
  total: number
  count: number
}

const CartContext = createContext<CartState | null>(null)
const STORAGE_KEY = 'snacklabs.cart'

export function CartProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    } catch {
      return []
    }
  })

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(lines))
  }, [lines])

  return (
    <CartContext.Provider
      value={{
        lines,
        add: (item) => setLines((l) => addToCart(l, item)),
        setLineQty: (id, qty) => setLines((l) => setQty(l, id, qty)),
        clear: () => setLines([]),
        total: cartTotal(lines),
        count: cartCount(lines),
      }}
    >
      {children}
    </CartContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useCart() {
  const ctx = useContext(CartContext)
  if (!ctx) throw new Error('useCart outside CartProvider')
  return ctx
}
```

Wrap `<App />` with `<CartProvider>` inside `<AuthProvider>` in `src/main.tsx`.

- [ ] **Step 7: Verify**

Run: `npm run test` → PASS. Run: `npm run build` → succeeds.

---

### Task 5: Customer store page

**Files:**
- Create: `src/pages/Store.tsx`, `src/components/ItemCard.tsx`, `src/components/CartBar.tsx`
- Modify: `src/App.tsx` (replace `/` placeholder with `<Store />`)

**Interfaces:**
- Consumes: `useCart()`, `useAuth()`, `supabase`, `formatPeso`, `Item`.
- Produces: routes `/` renders the store. `CartBar` links to `/cart` (Task 6).

- [ ] **Step 1: ItemCard**

`src/components/ItemCard.tsx`:

```tsx
import type { Item } from '../types'
import { formatPeso } from '../lib/money'
import { useCart } from '../context/CartContext'

export default function ItemCard({ item }: { item: Item }) {
  const { add, lines } = useCart()
  const inCart = lines.find((l) => l.item.id === item.id)?.qty ?? 0
  const out = item.stock <= 0
  const maxed = inCart >= item.stock

  return (
    <div className={`rounded-2xl bg-white shadow-sm overflow-hidden flex flex-col ${out ? 'opacity-50' : ''}`}>
      <div className="aspect-square bg-brand-50 flex items-center justify-center">
        {item.image_url
          ? <img src={item.image_url} alt={item.name} className="w-full h-full object-cover" />
          : <span className="text-4xl">🛒</span>}
      </div>
      <div className="p-3 flex flex-col gap-1 grow">
        <p className="font-medium text-sm leading-tight">{item.name}</p>
        <p className="text-brand-600 font-bold">{formatPeso(item.price)}</p>
        <p className="text-xs text-ink-500">{out ? 'Out of stock' : `${item.stock} left`}</p>
        <button
          disabled={out || maxed}
          onClick={() => add(item)}
          className="mt-auto rounded-lg bg-ink-900 text-white text-sm py-2 disabled:bg-stone-300 active:scale-95 transition"
        >
          {inCart > 0 ? `In cart · ${inCart}` : 'Add'}
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: CartBar**

`src/components/CartBar.tsx`:

```tsx
import { Link } from 'react-router'
import { useCart } from '../context/CartContext'
import { formatPeso } from '../lib/money'

export default function CartBar() {
  const { count, total } = useCart()
  if (count === 0) return null
  return (
    <Link
      to="/cart"
      className="fixed bottom-4 inset-x-4 max-w-md mx-auto rounded-2xl bg-brand-600 text-white px-5 py-3.5 flex items-center justify-between shadow-lg active:scale-[0.98] transition"
    >
      <span className="font-medium">{count} item{count > 1 ? 's' : ''}</span>
      <span className="font-bold">{formatPeso(total)} · View cart →</span>
    </Link>
  )
}
```

- [ ] **Step 3: Store page**

`src/pages/Store.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
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

  useEffect(() => {
    supabase.from('items').select('*').eq('is_active', true).order('name')
      .then(({ data }) => { setItems((data as Item[]) ?? []); setLoading(false) })
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
      <header className="sticky top-0 z-10 bg-surface/90 backdrop-blur px-4 pt-4 pb-2 space-y-3">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold">🍿 SnackLabs</h1>
          <div className="flex items-center gap-3 text-sm">
            <Link to="/orders" className="text-ink-500">My orders</Link>
            {profile?.is_admin && <Link to="/admin" className="text-brand-600 font-medium">Admin</Link>}
            <button onClick={signOut} className="text-ink-500">Sign out</button>
          </div>
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search snacks…"
          className="w-full rounded-xl bg-white px-4 py-2.5 text-sm shadow-sm outline-none focus:ring-2 ring-brand-500"
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
      ) : visible.length === 0 ? (
        <p className="p-8 text-center text-ink-500">Nothing here yet.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 px-4 pt-2">
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
      className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm capitalize transition ${
        active ? 'bg-ink-900 text-white' : 'bg-white text-ink-500 shadow-sm'
      }`}
    >
      {children}
    </button>
  )
}
```

- [ ] **Step 4: Route it**

In `src/App.tsx`, replace the `/` placeholder: `<Route path="/" element={<RequireAuth><Store /></RequireAuth>} />`.

- [ ] **Step 5: Verify**

Run: `npm run build` → succeeds. Seed 2–3 items via SQL editor (`insert into items (name, price, stock, category) values ('Piattos', 25, 10, 'snacks'), ('Coke Zero', 35, 6, 'drinks');`), then `npm run dev`: items render, search and chips filter, adding shows the cart bar, out-of-stock item (stock 0) is greyed.

---

### Task 6: Cart, checkout & QR payment screen

**Files:**
- Create: `src/pages/Cart.tsx`, `src/pages/Pay.tsx`
- Modify: `src/App.tsx` (add routes `/cart`, `/pay/:orderId`)

**Interfaces:**
- Consumes: `useCart()`, `supabase.rpc('create_order', ...)`, `PaymentMethod`, `Order`, `formatPeso`.
- Produces: `/cart` (review + choose payment method + place order → navigates to `/pay/:orderId`), `/pay/:orderId` (QR screen; its upload button is wired in Task 8 — for now it renders a disabled "Upload payment screenshot" button with `data-todo="task-8"`).

- [ ] **Step 1: Cart page**

`src/pages/Cart.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { supabase } from '../lib/supabase'
import { useCart } from '../context/CartContext'
import { formatPeso } from '../lib/money'
import type { PaymentMethod } from '../types'

export default function Cart() {
  const { lines, setLineQty, total, clear } = useCart()
  const [methods, setMethods] = useState<PaymentMethod[]>([])
  const [methodId, setMethodId] = useState<string | null>(null)
  const [placing, setPlacing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    supabase.from('payment_methods').select('*').eq('is_active', true)
      .then(({ data }) => {
        const m = (data as PaymentMethod[]) ?? []
        setMethods(m)
        if (m.length > 0) setMethodId(m[0].id)
      })
  }, [])

  const placeOrder = async () => {
    setPlacing(true)
    setError(null)
    const { data, error } = await supabase.rpc('create_order', {
      p_items: lines.map((l) => ({ item_id: l.item.id, qty: l.qty })),
      p_payment_method_id: methodId,
    })
    setPlacing(false)
    if (error) {
      setError(
        error.message.includes('insufficient stock')
          ? 'Someone beat you to it — an item just went out of stock. Adjust your cart.'
          : error.message,
      )
      return
    }
    clear()
    navigate(`/pay/${data}`)
  }

  if (lines.length === 0) {
    return (
      <div className="max-w-md mx-auto min-h-dvh flex flex-col items-center justify-center gap-3">
        <p className="text-ink-500">Your cart is empty.</p>
        <Link to="/" className="text-brand-600 font-medium">← Back to store</Link>
      </div>
    )
  }

  return (
    <div className="max-w-md mx-auto min-h-dvh px-4 py-4 space-y-5">
      <header className="flex items-center gap-3">
        <Link to="/" className="text-ink-500">←</Link>
        <h1 className="text-xl font-bold">Your cart</h1>
      </header>

      <div className="space-y-3">
        {lines.map(({ item, qty }) => (
          <div key={item.id} className="rounded-2xl bg-white p-3 shadow-sm flex items-center gap-3">
            <div className="size-14 rounded-xl bg-brand-50 flex items-center justify-center overflow-hidden">
              {item.image_url
                ? <img src={item.image_url} alt="" className="w-full h-full object-cover" />
                : '🛒'}
            </div>
            <div className="grow">
              <p className="font-medium text-sm">{item.name}</p>
              <p className="text-brand-600 font-bold text-sm">{formatPeso(item.price)}</p>
            </div>
            <div className="flex items-center gap-2">
              <Stepper onClick={() => setLineQty(item.id, qty - 1)}>−</Stepper>
              <span className="w-6 text-center font-medium">{qty}</span>
              <Stepper onClick={() => setLineQty(item.id, qty + 1)}>+</Stepper>
            </div>
          </div>
        ))}
      </div>

      <section className="space-y-2">
        <h2 className="font-semibold">Pay with</h2>
        {methods.length === 0 && (
          <p className="text-sm text-ink-500">No payment methods set up yet — ask your admin.</p>
        )}
        {methods.map((m) => (
          <button
            key={m.id}
            onClick={() => setMethodId(m.id)}
            className={`w-full rounded-xl p-3 text-left flex items-center gap-3 transition ${
              methodId === m.id ? 'bg-ink-900 text-white' : 'bg-white shadow-sm'
            }`}
          >
            <span>{m.type === 'ewallet' ? '📱' : '🏦'}</span>
            <span className="font-medium">{m.label}</span>
          </button>
        ))}
      </section>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        disabled={placing || !methodId}
        onClick={placeOrder}
        className="w-full rounded-2xl bg-brand-600 text-white py-4 font-bold text-lg disabled:bg-stone-300 active:scale-[0.98] transition"
      >
        {placing ? 'Placing order…' : `Pay ${formatPeso(total)}`}
      </button>
    </div>
  )
}

function Stepper({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="size-8 rounded-full bg-stone-100 font-bold active:scale-90 transition">
      {children}
    </button>
  )
}
```

- [ ] **Step 2: Pay page (QR display; upload wired in Task 8)**

`src/pages/Pay.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { supabase } from '../lib/supabase'
import { formatPeso } from '../lib/money'
import type { Order, PaymentMethod } from '../types'

export default function Pay() {
  const { orderId } = useParams()
  const [order, setOrder] = useState<Order | null>(null)
  const [method, setMethod] = useState<PaymentMethod | null>(null)

  useEffect(() => {
    if (!orderId) return
    supabase.from('orders').select('*').eq('id', orderId).single()
      .then(async ({ data }) => {
        const o = data as Order | null
        setOrder(o)
        if (o?.payment_method_id) {
          const { data: pm } = await supabase
            .from('payment_methods').select('*').eq('id', o.payment_method_id).single()
          setMethod(pm as PaymentMethod)
        }
      })
  }, [orderId])

  if (!order) return <div className="min-h-dvh flex items-center justify-center text-ink-500">Loading…</div>

  return (
    <div className="max-w-md mx-auto min-h-dvh px-4 py-4 space-y-5">
      <header className="flex items-center gap-3">
        <Link to="/" className="text-ink-500">←</Link>
        <h1 className="text-xl font-bold">Scan & pay</h1>
      </header>

      <div className="rounded-3xl bg-white p-6 shadow-sm text-center space-y-4">
        <p className="text-ink-500 text-sm">Amount due</p>
        <p className="text-4xl font-black text-brand-600">{formatPeso(order.total)}</p>
        {method && (
          <>
            <img src={method.qr_image_url} alt={`${method.label} QR code`} className="mx-auto w-64 rounded-2xl" />
            <div>
              <p className="font-semibold">{method.label}</p>
              <p className="text-sm text-ink-500">{method.account_name}</p>
            </div>
          </>
        )}
      </div>

      <PaymentStatus order={order} />
    </div>
  )
}

// Replaced in Task 8 with real upload + verification flow.
function PaymentStatus({ order }: { order: Order }) {
  if (order.status !== 'awaiting_payment') {
    return <p className="text-center text-ink-500 capitalize">{order.status.replace('_', ' ')}</p>
  }
  return (
    <button data-todo="task-8" disabled className="w-full rounded-2xl bg-stone-300 text-white py-4 font-bold">
      Upload payment screenshot
    </button>
  )
}
```

- [ ] **Step 3: Routes**

Add to `src/App.tsx`:

```tsx
<Route path="/cart" element={<RequireAuth><Cart /></RequireAuth>} />
<Route path="/pay/:orderId" element={<RequireAuth><Pay /></RequireAuth>} />
```

- [ ] **Step 4: Verify**

Run: `npm run build` → succeeds. Seed a payment method:
`insert into payment_methods (label, type, qr_image_url, account_name) values ('GCash', 'ewallet', 'https://placehold.co/400x400/png?text=QR', 'Snack Labs');`
In the dev app: add items → cart → steppers work → place order → lands on `/pay/:id` showing amount + QR. In SQL editor, confirm the order row: `select id, total, status from orders order by created_at desc limit 1;` → status `awaiting_payment`, total matches.

---

### Task 7: Payment verdict logic (TDD) + `verify-payment` Edge Function

**Files:**
- Create: `supabase/functions/_shared/verdict.ts`, `supabase/functions/verify-payment/index.ts`
- Test: `supabase/functions/_shared/verdict.test.ts`

**Interfaces:**
- Consumes: DB functions from Task 2 (`confirm_order`), `orders`/`payment_methods` tables, `receipts` bucket.
- Produces:
  - `decideOrderStatus(v: AiVerdictResult, orderTotal: number, refAlreadyUsed: boolean): 'paid' | 'needs_review'` in `_shared/verdict.ts` (pure — no Deno APIs, so Vitest can run it).
  - `AiVerdictResult` type identical in shape to the frontend `AiVerdict` (Task 4).
  - Edge Function `verify-payment`: `POST` body `{ order_id: string, receipt_path: string }`, requires user JWT. Responds `{ status: 'paid' | 'needs_review' }` or `{ error: string }` (4xx/5xx). Frontend (Task 8) calls it via `supabase.functions.invoke('verify-payment', { body })`.

- [ ] **Step 1: Write failing verdict tests**

`supabase/functions/_shared/verdict.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { decideOrderStatus, type AiVerdictResult } from './verdict'

const v = (over: Partial<AiVerdictResult> = {}): AiVerdictResult => ({
  verdict: 'pass',
  extracted: { amount: 60.5, recipient: 'Snack Labs', reference: 'REF123', timestamp: '2026-07-02' },
  reason: 'ok',
  ...over,
})

describe('decideOrderStatus', () => {
  it('pays when AI passes and amount matches', () => {
    expect(decideOrderStatus(v(), 60.5, false)).toBe('paid')
  })
  it('needs review when AI says fail or unsure', () => {
    expect(decideOrderStatus(v({ verdict: 'fail' }), 60.5, false)).toBe('needs_review')
    expect(decideOrderStatus(v({ verdict: 'unsure' }), 60.5, false)).toBe('needs_review')
  })
  it('needs review when amount mismatches or is missing', () => {
    expect(decideOrderStatus(v({ extracted: { ...v().extracted, amount: 60 } }), 60.5, false)).toBe('needs_review')
    expect(decideOrderStatus(v({ extracted: { ...v().extracted, amount: null } }), 60.5, false)).toBe('needs_review')
  })
  it('tolerates sub-centavo float noise', () => {
    expect(decideOrderStatus(v({ extracted: { ...v().extracted, amount: 60.500001 } }), 60.5, false)).toBe('paid')
  })
  it('needs review when the reference was already used', () => {
    expect(decideOrderStatus(v(), 60.5, true)).toBe('needs_review')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test` → FAIL: cannot find `./verdict`.

- [ ] **Step 3: Implement `supabase/functions/_shared/verdict.ts`**

```ts
export interface AiVerdictResult {
  verdict: 'pass' | 'fail' | 'unsure'
  extracted: {
    amount: number | null
    recipient: string | null
    reference: string | null
    timestamp: string | null
  }
  reason: string
}

export function decideOrderStatus(
  v: AiVerdictResult,
  orderTotal: number,
  refAlreadyUsed: boolean,
): 'paid' | 'needs_review' {
  if (refAlreadyUsed) return 'needs_review'
  if (v.verdict !== 'pass') return 'needs_review'
  if (v.extracted.amount === null) return 'needs_review'
  if (Math.abs(v.extracted.amount - orderTotal) > 0.009) return 'needs_review'
  return 'paid'
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test` → PASS.

- [ ] **Step 5: Implement the Edge Function**

`supabase/functions/verify-payment/index.ts`:

```ts
import { createClient } from 'npm:@supabase/supabase-js@2'
import Anthropic from 'npm:@anthropic-ai/sdk'
import { decideOrderStatus, type AiVerdictResult } from '../_shared/verdict.ts'

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail', 'unsure'] },
    extracted: {
      type: 'object',
      properties: {
        amount: { type: ['number', 'null'] },
        recipient: { type: ['string', 'null'] },
        reference: { type: ['string', 'null'] },
        timestamp: { type: ['string', 'null'] },
      },
      required: ['amount', 'recipient', 'reference', 'timestamp'],
      additionalProperties: false,
    },
    reason: { type: 'string' },
  },
  required: ['verdict', 'extracted', 'reason'],
  additionalProperties: false,
} as const

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  const { order_id, receipt_path } = await req.json().catch(() => ({}))
  if (!order_id || !receipt_path) return json({ error: 'order_id and receipt_path required' }, 400)

  // Client scoped to the calling user (validates JWT + ownership via RLS)
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } },
  )
  // Service client for privileged updates
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const { data: order, error: orderErr } = await userClient
    .from('orders').select('*').eq('id', order_id).single()
  if (orderErr || !order) return json({ error: 'order not found' }, 404)
  if (!['awaiting_payment', 'needs_review'].includes(order.status)) {
    return json({ error: `order is ${order.status}` }, 409)
  }

  const { data: method } = await admin
    .from('payment_methods').select('*').eq('id', order.payment_method_id).single()

  // Mark verifying + attach receipt
  await admin.from('orders')
    .update({ status: 'verifying', receipt_image_url: receipt_path })
    .eq('id', order_id)

  const parkForReview = async (reason: string, verdict: AiVerdictResult | null) => {
    await admin.from('orders')
      .update({ status: 'needs_review', ai_verdict: verdict ?? { verdict: 'unsure', extracted: { amount: null, recipient: null, reference: null, timestamp: null }, reason } })
      .eq('id', order_id)
    return json({ status: 'needs_review' })
  }

  // Download receipt image
  const { data: blob, error: dlErr } = await admin.storage.from('receipts').download(receipt_path)
  if (dlErr || !blob) return parkForReview('receipt image could not be read', null)
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let b64 = ''
  const CHUNK = 8192
  for (let i = 0; i < bytes.length; i += CHUNK) {
    b64 += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  b64 = btoa(b64)
  const mediaType = blob.type === 'image/png' ? 'image/png' : 'image/jpeg'

  // Ask Claude to read the receipt
  let verdict: AiVerdictResult
  try {
    const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY')! })
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 2048,
      output_config: { format: { type: 'json_schema', schema: VERDICT_SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
          {
            type: 'text',
            text: [
              'You are verifying a payment confirmation screenshot for an office pantry purchase.',
              `Expected amount: PHP ${order.total}.`,
              `Expected recipient: "${method?.account_name ?? 'unknown'}" via ${method?.label ?? 'unknown'} (account number ending in "${(method?.account_number ?? '').slice(-4)}").`,
              '',
              'Rubric:',
              '- verdict "pass" ONLY if this is clearly a genuine payment success screen, the amount exactly matches, and the recipient plausibly matches.',
              '- verdict "fail" if the amount or recipient clearly does not match, or the image is not a payment confirmation.',
              '- verdict "unsure" if anything is ambiguous, cropped, edited-looking, or unreadable.',
              'Extract the paid amount as a number, the recipient name, the reference/transaction number, and the payment timestamp. Use null for anything not visible.',
              'Explain briefly in "reason".',
            ].join('\n'),
          },
        ],
      }],
    })
    const text = response.content.find((b) => b.type === 'text')
    if (!text || text.type !== 'text') throw new Error('no text block')
    verdict = JSON.parse(text.text) as AiVerdictResult
  } catch (e) {
    return parkForReview(`AI verification unavailable: ${e instanceof Error ? e.message : e}`, null)
  }

  // Reference reuse check (blocks screenshot replay)
  let refAlreadyUsed = false
  if (verdict.extracted.reference) {
    const { count } = await admin
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'paid')
      .neq('id', order_id)
      .eq('ai_verdict->extracted->>reference', verdict.extracted.reference)
    refAlreadyUsed = (count ?? 0) > 0
  }

  const decision = decideOrderStatus(verdict, Number(order.total), refAlreadyUsed)

  if (decision === 'paid') {
    const { error: confirmErr } = await admin.rpc('confirm_order', {
      p_order_id: order_id,
      p_verdict: verdict,
    })
    if (confirmErr) return parkForReview(`stock confirmation failed: ${confirmErr.message}`, verdict)
    return json({ status: 'paid' })
  }

  if (refAlreadyUsed) verdict.reason = `Reference number already used on another paid order. ${verdict.reason}`
  return parkForReview(verdict.reason, verdict)
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
```

Note: Vitest must not pick up `index.ts` (it imports Deno/npm specifiers) — the vitest `include` from Task 1 only matches `_shared/`, and `verdict.ts` is dependency-free. The `../_shared/verdict.ts` import uses an explicit `.ts` extension (required by Deno).

- [ ] **Step 6: Deploy and verify**

```bash
supabase functions deploy verify-payment
supabase secrets list   # confirm ANTHROPIC_API_KEY is set; if not, STOP and ask the user
```

Expected: deploy succeeds. Full end-to-end verification happens in Task 8 (needs the upload UI). Sanity check now: calling it without auth returns 401:
`curl -s -X POST https://<project-ref>.supabase.co/functions/v1/verify-payment` → 401.

---

### Task 8: Receipt upload + verification flow + My Orders page

**Files:**
- Create: `src/lib/image.ts`, `src/pages/Orders.tsx`
- Modify: `src/pages/Pay.tsx` (replace the `PaymentStatus` placeholder), `src/App.tsx` (add `/orders`)

**Interfaces:**
- Consumes: `verify-payment` Edge Function (Task 7), `receipts` bucket, `Order`/`AiVerdict` types.
- Produces: `compressImage(file: File, maxDim?: number, quality?: number): Promise<Blob>` in `src/lib/image.ts` (canvas downscale to ≤1600px long edge, JPEG). Used again by Task 13.

- [ ] **Step 1: Image compression util**

`src/lib/image.ts`:

```ts
export async function compressImage(file: File, maxDim = 1600, quality = 0.8): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('compression failed'))),
      'image/jpeg',
      quality,
    ),
  )
}
```

- [ ] **Step 2: Replace `PaymentStatus` in `src/pages/Pay.tsx`**

Replace the placeholder `PaymentStatus` component with:

```tsx
import { useRef, useState } from 'react'
import { compressImage } from '../lib/image'
// (merge these imports with the existing ones at the top of Pay.tsx)

type Phase = 'idle' | 'uploading' | 'verifying' | 'done'

function PaymentStatus({ order, onUpdated }: { order: Order; onUpdated: (o: Order) => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)

  const handleFile = async (file: File) => {
    setError(null)
    setPhase('uploading')
    try {
      const blob = await compressImage(file)
      if (blob.size > 5 * 1024 * 1024) throw new Error('Image too large even after compression')
      const path = `${order.user_id}/${order.id}.jpg`
      const { error: upErr } = await supabase.storage
        .from('receipts')
        .upload(path, blob, { contentType: 'image/jpeg', upsert: true })
      if (upErr) throw upErr

      setPhase('verifying')
      const { data, error: fnErr } = await supabase.functions.invoke('verify-payment', {
        body: { order_id: order.id, receipt_path: path },
      })
      if (fnErr) throw fnErr

      const { data: fresh } = await supabase.from('orders').select('*').eq('id', order.id).single()
      if (fresh) onUpdated(fresh as Order)
      setPhase('done')
      void data
    } catch (e) {
      setPhase('idle')
      setError(e instanceof Error ? e.message : 'Something went wrong — try again.')
    }
  }

  if (order.status === 'paid') {
    return (
      <div className="rounded-2xl bg-green-50 text-green-800 p-5 text-center space-y-1">
        <p className="text-3xl">✅</p>
        <p className="font-bold">Payment verified — enjoy!</p>
      </div>
    )
  }
  if (order.status === 'needs_review') {
    return (
      <div className="rounded-2xl bg-amber-50 text-amber-800 p-5 text-center space-y-1">
        <p className="text-3xl">🕐</p>
        <p className="font-bold">Sent to admin for review</p>
        {order.ai_verdict?.reason && <p className="text-sm">{order.ai_verdict.reason}</p>}
      </div>
    )
  }
  if (order.status === 'cancelled') {
    return <p className="text-center text-ink-500">This order was cancelled.</p>
  }

  return (
    <div className="space-y-2">
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
      />
      <button
        disabled={phase !== 'idle'}
        onClick={() => fileRef.current?.click()}
        className="w-full rounded-2xl bg-brand-600 text-white py-4 font-bold disabled:bg-stone-300 active:scale-[0.98] transition"
      >
        {phase === 'idle' && "I've paid — upload screenshot"}
        {phase === 'uploading' && 'Uploading…'}
        {phase === 'verifying' && 'Verifying with AI…'}
        {phase === 'done' && 'Done'}
      </button>
      {error && <p className="text-sm text-red-600 text-center">{error}</p>}
    </div>
  )
}
```

Wire it in `Pay`: `<PaymentStatus order={order} onUpdated={setOrder} />` (replace the old usage; keep `order.status !== 'awaiting_payment'` handling inside the new component as shown).

- [ ] **Step 3: My Orders page**

`src/pages/Orders.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { supabase } from '../lib/supabase'
import { formatPeso } from '../lib/money'
import type { Order, OrderStatus } from '../types'

const STATUS_STYLE: Record<OrderStatus, string> = {
  awaiting_payment: 'bg-stone-100 text-ink-500',
  verifying: 'bg-blue-50 text-blue-700',
  paid: 'bg-green-50 text-green-700',
  needs_review: 'bg-amber-50 text-amber-700',
  cancelled: 'bg-stone-100 text-ink-500 line-through',
}

export default function Orders() {
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.from('orders').select('*').order('created_at', { ascending: false })
      .then(({ data }) => { setOrders((data as Order[]) ?? []); setLoading(false) })
  }, [])

  return (
    <div className="max-w-md mx-auto min-h-dvh px-4 py-4 space-y-4">
      <header className="flex items-center gap-3">
        <Link to="/" className="text-ink-500">←</Link>
        <h1 className="text-xl font-bold">My orders</h1>
      </header>
      {loading ? (
        <p className="text-center text-ink-500 py-8">Loading…</p>
      ) : orders.length === 0 ? (
        <p className="text-center text-ink-500 py-8">No orders yet.</p>
      ) : (
        orders.map((o) => (
          <Link
            key={o.id}
            to={`/pay/${o.id}`}
            className="block rounded-2xl bg-white p-4 shadow-sm space-y-1"
          >
            <div className="flex items-center justify-between">
              <span className="font-bold">{formatPeso(o.total)}</span>
              <span className={`text-xs rounded-full px-2.5 py-1 capitalize ${STATUS_STYLE[o.status]}`}>
                {o.status.replace('_', ' ')}
              </span>
            </div>
            <p className="text-xs text-ink-500">{new Date(o.created_at).toLocaleString()}</p>
            {o.status === 'needs_review' && o.ai_verdict?.reason && (
              <p className="text-xs text-amber-700">{o.ai_verdict.reason}</p>
            )}
          </Link>
        ))
      )}
    </div>
  )
}
```

Add route: `<Route path="/orders" element={<RequireAuth><Orders /></RequireAuth>} />`.

- [ ] **Step 4: End-to-end verification**

Run: `npm run test` and `npm run build` → both pass. Then in the dev app: place an order, upload a real GCash/bank screenshot (or any image — expect `needs_review` for a random image). Verify:
- Random image → status becomes `needs_review`, reason shown.
- SQL check: `select status, ai_verdict->>'reason' from orders order by created_at desc limit 1;`
- If a genuine matching screenshot is available, it should go `paid` and item stock should decrement (`select name, stock from items;`).

---

### Task 9: Admin shell + dashboard

**Files:**
- Create: `src/pages/admin/AdminLayout.tsx`, `src/pages/admin/Dashboard.tsx`
- Modify: `src/App.tsx` (replace `/admin/*` placeholder with nested routes)

**Interfaces:**
- Consumes: `useAuth()`, `supabase`, `formatPeso`.
- Produces: `AdminLayout` renders `<Outlet />` with a sidebar (`md:` and up) and bottom tab bar (mobile). Nav items: Dashboard `/admin`, Items `/admin/items`, Restock `/admin/restock`, Orders `/admin/orders`, Payments `/admin/payments`. Tasks 10–13 fill these routes; until then unfilled routes may 404 within the layout — acceptable.

- [ ] **Step 1: AdminLayout**

`src/pages/admin/AdminLayout.tsx`:

```tsx
import { NavLink, Outlet, Link } from 'react-router'

const NAV = [
  { to: '/admin', label: 'Dashboard', icon: '📊', end: true },
  { to: '/admin/items', label: 'Items', icon: '🧃', end: false },
  { to: '/admin/restock', label: 'Restock', icon: '📷', end: false },
  { to: '/admin/orders', label: 'Orders', icon: '🧾', end: false },
  { to: '/admin/payments', label: 'Payments', icon: '💳', end: false },
]

export default function AdminLayout() {
  return (
    <div className="min-h-dvh md:flex">
      <aside className="hidden md:flex md:flex-col w-56 shrink-0 border-r border-stone-200 bg-white p-4 gap-1">
        <Link to="/" className="font-bold text-lg mb-4">🍿 SnackLabs</Link>
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) =>
              `rounded-xl px-3 py-2.5 text-sm font-medium transition ${
                isActive ? 'bg-ink-900 text-white' : 'text-ink-500 hover:bg-stone-100'
              }`
            }
          >
            {n.icon} {n.label}
          </NavLink>
        ))}
      </aside>

      <main className="grow pb-24 md:pb-8">
        <Outlet />
      </main>

      <nav className="md:hidden fixed bottom-0 inset-x-0 bg-white border-t border-stone-200 flex justify-around py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) =>
              `flex flex-col items-center gap-0.5 text-[10px] px-2 ${
                isActive ? 'text-brand-600 font-bold' : 'text-ink-500'
              }`
            }
          >
            <span className="text-xl">{n.icon}</span>
            {n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
```

- [ ] **Step 2: Dashboard**

`src/pages/admin/Dashboard.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { supabase } from '../../lib/supabase'
import { formatPeso } from '../../lib/money'
import type { Item, Order } from '../../types'

export default function Dashboard() {
  const [todaySales, setTodaySales] = useState(0)
  const [reviewCount, setReviewCount] = useState(0)
  const [lowStock, setLowStock] = useState<Item[]>([])

  useEffect(() => {
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)

    supabase.from('orders').select('total')
      .eq('status', 'paid').gte('created_at', startOfDay.toISOString())
      .then(({ data }) =>
        setTodaySales(((data as Pick<Order, 'total'>[]) ?? []).reduce((s, o) => s + Number(o.total), 0)))

    supabase.from('orders').select('id', { count: 'exact', head: true })
      .eq('status', 'needs_review')
      .then(({ count }) => setReviewCount(count ?? 0))

    supabase.from('items').select('*').eq('is_active', true)
      .then(({ data }) =>
        setLowStock(((data as Item[]) ?? []).filter((i) => i.stock <= i.low_stock_threshold)))
  }, [])

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-3xl">
      <h1 className="text-2xl font-bold">Dashboard</h1>
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-2xl bg-white p-5 shadow-sm">
          <p className="text-sm text-ink-500">Sales today</p>
          <p className="text-2xl font-black text-brand-600">{formatPeso(todaySales)}</p>
        </div>
        <Link to="/admin/orders?filter=needs_review" className="rounded-2xl bg-white p-5 shadow-sm">
          <p className="text-sm text-ink-500">Needs review</p>
          <p className={`text-2xl font-black ${reviewCount > 0 ? 'text-amber-600' : ''}`}>{reviewCount}</p>
        </Link>
      </div>
      <section className="space-y-2">
        <h2 className="font-semibold">Low stock</h2>
        {lowStock.length === 0 ? (
          <p className="text-sm text-ink-500">All stocked up 🎉</p>
        ) : (
          lowStock.map((i) => (
            <div key={i.id} className="rounded-xl bg-white p-3 shadow-sm flex justify-between text-sm">
              <span>{i.name}</span>
              <span className="font-bold text-amber-600">{i.stock} left</span>
            </div>
          ))
        )}
      </section>
    </div>
  )
}
```

- [ ] **Step 3: Routes**

In `src/App.tsx`, replace the `/admin/*` placeholder route:

```tsx
<Route path="/admin" element={<RequireAdmin><AdminLayout /></RequireAdmin>}>
  <Route index element={<Dashboard />} />
  {/* Tasks 10–13 add: items, restock, orders, payments */}
</Route>
```

- [ ] **Step 4: Verify**

Run: `npm run build` → succeeds. As the admin user: `/admin` shows dashboard numbers (needs_review count matches Task 8's test order). Non-admin account gets bounced to `/`. Resize to mobile width: bottom tabs render; desktop: sidebar.

---

### Task 10: Admin — Items CRUD

**Files:**
- Create: `src/pages/admin/Items.tsx`
- Modify: `src/App.tsx` (add `<Route path="items" element={<Items />} />` under the admin route)

**Interfaces:**
- Consumes: `Item` type, `supabase` (`items` table writes are admin-gated by RLS), `item-images` bucket, `compressImage` (Task 8), `formatPeso`.
- Produces: `/admin/items` — list with inline stock adjust, add/edit modal form, soft delete (sets `is_active = false`).

- [ ] **Step 1: Implement `src/pages/admin/Items.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { formatPeso } from '../../lib/money'
import { compressImage } from '../../lib/image'
import type { Item } from '../../types'

type Draft = {
  id?: string
  name: string
  price: string
  stock: string
  category: string
  low_stock_threshold: string
  file?: File | null
}

const EMPTY: Draft = { name: '', price: '', stock: '0', category: 'snacks', low_stock_threshold: '3', file: null }

export default function Items() {
  const [items, setItems] = useState<Item[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = () =>
    supabase.from('items').select('*').eq('is_active', true).order('name')
      .then(({ data }) => setItems((data as Item[]) ?? []))

  useEffect(() => { load() }, [])

  const adjustStock = async (item: Item, delta: number) => {
    const next = Math.max(0, item.stock + delta)
    setItems((all) => all.map((i) => (i.id === item.id ? { ...i, stock: next } : i)))
    await supabase.from('items').update({ stock: next }).eq('id', item.id)
  }

  const save = async () => {
    if (!draft) return
    setSaving(true)
    setError(null)
    try {
      let image_url: string | undefined
      if (draft.file) {
        const blob = await compressImage(draft.file, 800)
        const path = `${crypto.randomUUID()}.jpg`
        const { error: upErr } = await supabase.storage
          .from('item-images').upload(path, blob, { contentType: 'image/jpeg' })
        if (upErr) throw upErr
        image_url = supabase.storage.from('item-images').getPublicUrl(path).data.publicUrl
      }
      const payload = {
        name: draft.name.trim(),
        price: Number(draft.price),
        stock: Number(draft.stock),
        category: draft.category.trim() || 'snacks',
        low_stock_threshold: Number(draft.low_stock_threshold),
        ...(image_url ? { image_url } : {}),
      }
      if (!payload.name || Number.isNaN(payload.price)) throw new Error('Name and price are required')
      const q = draft.id
        ? supabase.from('items').update(payload).eq('id', draft.id)
        : supabase.from('items').insert(payload)
      const { error: dbErr } = await q
      if (dbErr) throw dbErr
      setDraft(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const deactivate = async (item: Item) => {
    if (!confirm(`Remove "${item.name}" from the store?`)) return
    await supabase.from('items').update({ is_active: false }).eq('id', item.id)
    await load()
  }

  return (
    <div className="p-4 md:p-8 space-y-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Items</h1>
        <button
          onClick={() => setDraft({ ...EMPTY })}
          className="rounded-xl bg-brand-600 text-white px-4 py-2 font-medium"
        >
          + Add item
        </button>
      </div>

      <div className="space-y-2">
        {items.map((i) => (
          <div key={i.id} className="rounded-2xl bg-white p-3 shadow-sm flex items-center gap-3">
            <div className="size-12 rounded-xl bg-brand-50 overflow-hidden flex items-center justify-center shrink-0">
              {i.image_url ? <img src={i.image_url} alt="" className="w-full h-full object-cover" /> : '🛒'}
            </div>
            <div className="grow min-w-0">
              <p className="font-medium text-sm truncate">{i.name}</p>
              <p className="text-xs text-ink-500">{formatPeso(i.price)} · {i.category}</p>
            </div>
            <div className="flex items-center gap-1.5">
              <button onClick={() => adjustStock(i, -1)} className="size-8 rounded-full bg-stone-100 font-bold">−</button>
              <span className={`w-8 text-center font-bold text-sm ${i.stock <= i.low_stock_threshold ? 'text-amber-600' : ''}`}>
                {i.stock}
              </span>
              <button onClick={() => adjustStock(i, 1)} className="size-8 rounded-full bg-stone-100 font-bold">+</button>
            </div>
            <button
              onClick={() => setDraft({
                id: i.id, name: i.name, price: String(i.price), stock: String(i.stock),
                category: i.category, low_stock_threshold: String(i.low_stock_threshold), file: null,
              })}
              className="text-sm text-ink-500 px-1"
            >
              Edit
            </button>
            <button onClick={() => deactivate(i)} className="text-sm text-red-400 px-1">✕</button>
          </div>
        ))}
      </div>

      {draft && (
        <div className="fixed inset-0 z-20 bg-black/40 flex items-end md:items-center justify-center" onClick={() => setDraft(null)}>
          <div className="bg-white rounded-t-3xl md:rounded-3xl w-full max-w-md p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-bold text-lg">{draft.id ? 'Edit item' : 'New item'}</h2>
            <Field label="Name"><input className={inputCls} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Price (₱)"><input className={inputCls} inputMode="decimal" value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} /></Field>
              <Field label="Stock"><input className={inputCls} inputMode="numeric" value={draft.stock} onChange={(e) => setDraft({ ...draft, stock: e.target.value })} /></Field>
              <Field label="Category"><input className={inputCls} value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} /></Field>
              <Field label="Low stock alert"><input className={inputCls} inputMode="numeric" value={draft.low_stock_threshold} onChange={(e) => setDraft({ ...draft, low_stock_threshold: e.target.value })} /></Field>
            </div>
            <Field label="Photo">
              <input type="file" accept="image/*" onChange={(e) => setDraft({ ...draft, file: e.target.files?.[0] ?? null })} className="text-sm" />
            </Field>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <div className="flex gap-2 pt-1">
              <button onClick={() => setDraft(null)} className="grow rounded-xl bg-stone-100 py-3 font-medium">Cancel</button>
              <button onClick={save} disabled={saving} className="grow rounded-xl bg-ink-900 text-white py-3 font-medium disabled:opacity-50">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const inputCls = 'w-full rounded-xl bg-stone-50 border border-stone-200 px-3 py-2.5 text-sm outline-none focus:ring-2 ring-brand-500'
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-ink-500">{label}</span>
      {children}
    </label>
  )
}
```

- [ ] **Step 2: Route + verify**

Add `<Route path="items" element={<Items />} />` under the admin route. Run `npm run build` → succeeds. In the dev app as admin: add an item with a photo (image appears via public URL), inline +/− updates stock (confirm in SQL), edit works, ✕ soft-deletes (item disappears from store and admin list but the row remains: `select name, is_active from items;`).

---

### Task 11: Admin — Payment methods CRUD

**Files:**
- Create: `src/pages/admin/Payments.tsx`
- Modify: `src/App.tsx` (add `<Route path="payments" element={<Payments />} />`)

**Interfaces:**
- Consumes: `PaymentMethod` type, `qr-codes` bucket, `compressImage`.
- Produces: `/admin/payments` — list, add/edit form (label, type, account name/number, QR image upload), active toggle.

- [ ] **Step 1: Implement `src/pages/admin/Payments.tsx`**

Same structural pattern as Task 10 (list + modal form). Full code:

```tsx
import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { compressImage } from '../../lib/image'
import type { PaymentMethod } from '../../types'

type Draft = {
  id?: string
  label: string
  type: 'ewallet' | 'bank'
  account_name: string
  account_number: string
  file?: File | null
  existing_qr?: string
}

const EMPTY: Draft = { label: '', type: 'ewallet', account_name: '', account_number: '', file: null }

export default function Payments() {
  const [methods, setMethods] = useState<PaymentMethod[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = () =>
    supabase.from('payment_methods').select('*').order('created_at')
      .then(({ data }) => setMethods((data as PaymentMethod[]) ?? []))

  useEffect(() => { load() }, [])

  const save = async () => {
    if (!draft) return
    setSaving(true)
    setError(null)
    try {
      let qr_image_url = draft.existing_qr
      if (draft.file) {
        const blob = await compressImage(draft.file, 1000, 0.9)
        const path = `${crypto.randomUUID()}.jpg`
        const { error: upErr } = await supabase.storage
          .from('qr-codes').upload(path, blob, { contentType: 'image/jpeg' })
        if (upErr) throw upErr
        qr_image_url = supabase.storage.from('qr-codes').getPublicUrl(path).data.publicUrl
      }
      if (!draft.label.trim() || !draft.account_name.trim()) throw new Error('Label and account name are required')
      if (!qr_image_url) throw new Error('A QR code image is required')
      const payload = {
        label: draft.label.trim(),
        type: draft.type,
        account_name: draft.account_name.trim(),
        account_number: draft.account_number.trim(),
        qr_image_url,
      }
      const q = draft.id
        ? supabase.from('payment_methods').update(payload).eq('id', draft.id)
        : supabase.from('payment_methods').insert(payload)
      const { error: dbErr } = await q
      if (dbErr) throw dbErr
      setDraft(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const toggle = async (m: PaymentMethod) => {
    await supabase.from('payment_methods').update({ is_active: !m.is_active }).eq('id', m.id)
    await load()
  }

  return (
    <div className="p-4 md:p-8 space-y-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Payment methods</h1>
        <button onClick={() => setDraft({ ...EMPTY })} className="rounded-xl bg-brand-600 text-white px-4 py-2 font-medium">
          + Add
        </button>
      </div>

      <div className="space-y-2">
        {methods.map((m) => (
          <div key={m.id} className={`rounded-2xl bg-white p-3 shadow-sm flex items-center gap-3 ${m.is_active ? '' : 'opacity-50'}`}>
            <img src={m.qr_image_url} alt="" className="size-12 rounded-xl object-cover" />
            <div className="grow">
              <p className="font-medium text-sm">{m.type === 'ewallet' ? '📱' : '🏦'} {m.label}</p>
              <p className="text-xs text-ink-500">{m.account_name} {m.account_number && `· ${m.account_number}`}</p>
            </div>
            <button onClick={() => toggle(m)} className="text-sm text-ink-500 px-1">
              {m.is_active ? 'Disable' : 'Enable'}
            </button>
            <button
              onClick={() => setDraft({
                id: m.id, label: m.label, type: m.type, account_name: m.account_name,
                account_number: m.account_number, file: null, existing_qr: m.qr_image_url,
              })}
              className="text-sm text-ink-500 px-1"
            >
              Edit
            </button>
          </div>
        ))}
      </div>

      {draft && (
        <div className="fixed inset-0 z-20 bg-black/40 flex items-end md:items-center justify-center" onClick={() => setDraft(null)}>
          <div className="bg-white rounded-t-3xl md:rounded-3xl w-full max-w-md p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-bold text-lg">{draft.id ? 'Edit method' : 'New payment method'}</h2>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-ink-500">Label (e.g. GCash, BPI)</span>
              <input className={inputCls} value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
            </label>
            <div className="flex gap-2">
              {(['ewallet', 'bank'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setDraft({ ...draft, type: t })}
                  className={`grow rounded-xl py-2.5 text-sm font-medium ${draft.type === t ? 'bg-ink-900 text-white' : 'bg-stone-100'}`}
                >
                  {t === 'ewallet' ? '📱 E-wallet' : '🏦 Bank'}
                </button>
              ))}
            </div>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-ink-500">Account name</span>
              <input className={inputCls} value={draft.account_name} onChange={(e) => setDraft({ ...draft, account_name: e.target.value })} />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-ink-500">Account / mobile number</span>
              <input className={inputCls} value={draft.account_number} onChange={(e) => setDraft({ ...draft, account_number: e.target.value })} />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-ink-500">QR code image</span>
              <input type="file" accept="image/*" className="text-sm" onChange={(e) => setDraft({ ...draft, file: e.target.files?.[0] ?? null })} />
            </label>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <div className="flex gap-2 pt-1">
              <button onClick={() => setDraft(null)} className="grow rounded-xl bg-stone-100 py-3 font-medium">Cancel</button>
              <button onClick={save} disabled={saving} className="grow rounded-xl bg-ink-900 text-white py-3 font-medium disabled:opacity-50">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const inputCls = 'w-full rounded-xl bg-stone-50 border border-stone-200 px-3 py-2.5 text-sm outline-none focus:ring-2 ring-brand-500'
```

- [ ] **Step 2: Route + verify**

Add `<Route path="payments" element={<Payments />} />`. Run `npm run build` → succeeds. As admin: create a real GCash method with an uploaded QR image; disable/enable toggles; customer cart (Task 6) now shows it and `/pay/:id` renders the uploaded QR.

---

### Task 12: Admin — Orders list + review queue

**Files:**
- Create: `src/pages/admin/AdminOrders.tsx`
- Modify: `src/App.tsx` (add `<Route path="orders" element={<AdminOrders />} />`)

**Interfaces:**
- Consumes: `Order`, `confirm_order` RPC (admins pass the `is_admin()` check inside it), `receipts` bucket (signed URLs), `profiles`.
- Produces: `/admin/orders?filter=<status>` — filterable list; `needs_review` orders expand to show the receipt image beside the AI verdict, with Approve (→ `confirm_order`) and Reject (→ status `cancelled`) buttons.

- [ ] **Step 1: Implement `src/pages/admin/AdminOrders.tsx`**

```tsx
import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { supabase } from '../../lib/supabase'
import { formatPeso } from '../../lib/money'
import type { Order, OrderStatus } from '../../types'

interface OrderRow extends Order {
  profiles: { full_name: string; email: string } | null
}

const FILTERS: (OrderStatus | 'all')[] = ['needs_review', 'all', 'paid', 'verifying', 'awaiting_payment', 'cancelled']

export default function AdminOrders() {
  const [params, setParams] = useSearchParams()
  const filter = (params.get('filter') ?? 'needs_review') as OrderStatus | 'all'
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    let q = supabase.from('orders')
      .select('*, profiles(full_name, email)')
      .order('created_at', { ascending: false })
      .limit(100)
    if (filter !== 'all') q = q.eq('status', filter)
    const { data } = await q
    setOrders((data as OrderRow[]) ?? [])
  }, [filter])

  useEffect(() => { load() }, [load])

  const openOrder = async (o: OrderRow) => {
    setOpen(open === o.id ? null : o.id)
    setReceiptUrl(null)
    if (o.receipt_image_url) {
      const { data } = await supabase.storage
        .from('receipts').createSignedUrl(o.receipt_image_url, 300)
      setReceiptUrl(data?.signedUrl ?? null)
    }
  }

  const approve = async (o: OrderRow) => {
    setBusy(true)
    const { error } = await supabase.rpc('confirm_order', { p_order_id: o.id, p_verdict: null })
    setBusy(false)
    if (error) { alert(error.message); return }
    setOpen(null)
    await load()
  }

  const reject = async (o: OrderRow) => {
    if (!confirm('Cancel this order?')) return
    setBusy(true)
    await supabase.from('orders').update({ status: 'cancelled' }).eq('id', o.id)
    setBusy(false)
    setOpen(null)
    await load()
  }

  return (
    <div className="p-4 md:p-8 space-y-4 max-w-3xl">
      <h1 className="text-2xl font-bold">Orders</h1>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setParams({ filter: f })}
            className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm capitalize ${
              filter === f ? 'bg-ink-900 text-white' : 'bg-white text-ink-500 shadow-sm'
            }`}
          >
            {f.replace('_', ' ')}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {orders.length === 0 && <p className="text-sm text-ink-500 py-6 text-center">Nothing here.</p>}
        {orders.map((o) => (
          <div key={o.id} className="rounded-2xl bg-white shadow-sm overflow-hidden">
            <button onClick={() => openOrder(o)} className="w-full p-3 flex items-center justify-between text-left">
              <div>
                <p className="font-medium text-sm">{o.profiles?.full_name || o.profiles?.email || 'Unknown'}</p>
                <p className="text-xs text-ink-500">{new Date(o.created_at).toLocaleString()}</p>
              </div>
              <div className="text-right">
                <p className="font-bold">{formatPeso(o.total)}</p>
                <p className="text-xs capitalize text-ink-500">{o.status.replace('_', ' ')}</p>
              </div>
            </button>

            {open === o.id && (
              <div className="border-t border-stone-100 p-3 space-y-3">
                {o.ai_verdict && (
                  <div className="rounded-xl bg-stone-50 p-3 text-sm space-y-1">
                    <p><b>AI verdict:</b> {o.ai_verdict.verdict}</p>
                    <p><b>Read amount:</b> {o.ai_verdict.extracted.amount != null ? formatPeso(o.ai_verdict.extracted.amount) : '—'}</p>
                    <p><b>Reference:</b> {o.ai_verdict.extracted.reference ?? '—'}</p>
                    <p className="text-ink-500">{o.ai_verdict.reason}</p>
                  </div>
                )}
                {receiptUrl
                  ? <img src={receiptUrl} alt="Receipt" className="rounded-xl max-h-96 mx-auto" />
                  : o.receipt_image_url && <p className="text-xs text-ink-500">Loading receipt…</p>}
                {['needs_review', 'verifying', 'awaiting_payment'].includes(o.status) && (
                  <div className="flex gap-2">
                    <button onClick={() => reject(o)} disabled={busy} className="grow rounded-xl bg-red-50 text-red-600 py-3 font-medium disabled:opacity-50">
                      Reject
                    </button>
                    <button onClick={() => approve(o)} disabled={busy} className="grow rounded-xl bg-green-600 text-white py-3 font-medium disabled:opacity-50">
                      Approve & mark paid
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Route + verify**

Add `<Route path="orders" element={<AdminOrders />} />`. Run `npm run build` → succeeds. As admin: the `needs_review` order from Task 8 shows AI verdict + receipt image (signed URL loads). Approve it → status `paid`, stock decrements (verify in SQL). Reject flow sets `cancelled`. Dashboard review count drops to 0.

---

### Task 13: `analyze-shelf` Edge Function + AI Restock page

**Files:**
- Create: `supabase/functions/analyze-shelf/index.ts`, `src/pages/admin/Restock.tsx`
- Modify: `src/App.tsx` (add `<Route path="restock" element={<Restock />} />`)

**Interfaces:**
- Consumes: `restock-photos` bucket, `restock_sessions` table, `apply_restock` RPC, `compressImage`, `RestockDetection`/`RestockSession` types.
- Produces: Edge Function `analyze-shelf`: `POST` body `{ photo_path: string }`, admin JWT required. Responds `{ session_id: string, detections: RestockDetection[] }` or `{ error }`. `/admin/restock` page: take/upload photo → review editable rows → Apply.

- [ ] **Step 1: Edge Function**

`supabase/functions/analyze-shelf/index.ts`:

```ts
import { createClient } from 'npm:@supabase/supabase-js@2'
import Anthropic from 'npm:@anthropic-ai/sdk'

const DETECTIONS_SCHEMA = {
  type: 'object',
  properties: {
    detections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          matched_item_id: { type: ['string', 'null'] },
          name: { type: 'string' },
          qty: { type: 'integer' },
          suggested_price: { type: ['number', 'null'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['matched_item_id', 'name', 'qty', 'suggested_price', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['detections'],
  additionalProperties: false,
} as const

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
  const { photo_path } = await req.json().catch(() => ({}))
  if (!photo_path) return json({ error: 'photo_path required' }, 400)

  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } },
  )
  const { data: { user } } = await userClient.auth.getUser()
  if (!user) return json({ error: 'unauthenticated' }, 401)
  const { data: profile } = await userClient
    .from('profiles').select('is_admin').eq('id', user.id).single()
  if (!profile?.is_admin) return json({ error: 'admin only' }, 403)

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const { data: catalog } = await admin
    .from('items').select('id, name, price').eq('is_active', true)

  const { data: blob, error: dlErr } = await admin.storage.from('restock-photos').download(photo_path)
  if (dlErr || !blob) return json({ error: 'photo could not be read' }, 400)
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let b64 = ''
  const CHUNK = 8192
  for (let i = 0; i < bytes.length; i += CHUNK) {
    b64 += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  b64 = btoa(b64)

  let result: { detections: unknown[] }
  try {
    const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY')! })
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 4096,
      output_config: { format: { type: 'json_schema', schema: DETECTIONS_SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: blob.type === 'image/png' ? 'image/png' : 'image/jpeg', data: b64 } },
          {
            type: 'text',
            text: [
              'This is a photo of office pantry stock (a shelf or a fresh delivery), taken in the Philippines.',
              'Identify each distinct product and count how many units are visible.',
              '',
              'Current catalog (match against these when the product is the same; use the exact id):',
              JSON.stringify(catalog ?? []),
              '',
              'Rules:',
              '- If a detected product matches a catalog item, set matched_item_id to that id and suggested_price to null.',
              '- If it is not in the catalog, set matched_item_id to null, give a clean product name, and suggest a reasonable PHP retail price.',
              '- qty is your best count of visible units; be conservative.',
              '- confidence reflects how sure you are about the identification AND the count.',
              '- Ignore non-products (shelf fixtures, signage, hands).',
            ].join('\n'),
          },
        ],
      }],
    })
    const text = response.content.find((b) => b.type === 'text')
    if (!text || text.type !== 'text') throw new Error('no text block')
    result = JSON.parse(text.text)
  } catch (e) {
    return json({ error: `AI analysis failed: ${e instanceof Error ? e.message : e}` }, 502)
  }

  const { data: session, error: insErr } = await admin
    .from('restock_sessions')
    .insert({ admin_id: user.id, photo_url: photo_path, ai_result: result })
    .select('id')
    .single()
  if (insErr) return json({ error: insErr.message }, 500)

  return json({ session_id: session.id, detections: result.detections })
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
```

- [ ] **Step 2: Deploy**

Run: `supabase functions deploy analyze-shelf` → succeeds.

- [ ] **Step 3: Restock page**

`src/pages/admin/Restock.tsx`:

```tsx
import { useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { compressImage } from '../../lib/image'
import type { RestockDetection } from '../../types'

type Line = RestockDetection & { include: boolean; price: string }
type Phase = 'idle' | 'analyzing' | 'review' | 'applying' | 'done'

export default function Restock() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [preview, setPreview] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const analyze = async (file: File) => {
    setError(null)
    setPhase('analyzing')
    setPreview(URL.createObjectURL(file))
    try {
      const blob = await compressImage(file, 1600, 0.85)
      const path = `${crypto.randomUUID()}.jpg`
      const { error: upErr } = await supabase.storage
        .from('restock-photos').upload(path, blob, { contentType: 'image/jpeg' })
      if (upErr) throw upErr

      const { data, error: fnErr } = await supabase.functions.invoke('analyze-shelf', {
        body: { photo_path: path },
      })
      if (fnErr) throw fnErr
      const detections = (data.detections ?? []) as RestockDetection[]
      setSessionId(data.session_id)
      setLines(detections.map((d) => ({
        ...d,
        include: true,
        price: d.suggested_price != null ? String(d.suggested_price) : '',
      })))
      setPhase('review')
    } catch (e) {
      setPhase('idle')
      setError(e instanceof Error ? e.message : 'Analysis failed — try again.')
    }
  }

  const apply = async () => {
    setPhase('applying')
    setError(null)
    const payload = lines
      .filter((l) => l.include && l.qty > 0)
      .map((l) => ({
        item_id: l.matched_item_id,
        name: l.name,
        price: l.price ? Number(l.price) : 0,
        qty: l.qty,
        category: 'snacks',
      }))
    const { error: rpcErr } = await supabase.rpc('apply_restock', {
      p_session_id: sessionId,
      p_lines: payload,
    })
    if (rpcErr) {
      setPhase('review')
      setError(rpcErr.message)
      return
    }
    setPhase('done')
  }

  const reset = () => {
    setPhase('idle'); setLines([]); setSessionId(null); setPreview(null); setError(null)
  }

  const edit = (i: number, patch: Partial<Line>) =>
    setLines((all) => all.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))

  return (
    <div className="p-4 md:p-8 space-y-4 max-w-3xl">
      <h1 className="text-2xl font-bold">📷 AI Restock</h1>
      <input
        ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden"
        onChange={(e) => e.target.files?.[0] && analyze(e.target.files[0])}
      />

      {phase === 'idle' && (
        <div className="rounded-3xl bg-white p-8 shadow-sm text-center space-y-4">
          <p className="text-5xl">🥡</p>
          <p className="text-ink-500 text-sm">
            Snap a photo of the shelf or a new delivery.<br />
            Claude will count items and match them to your catalog.
          </p>
          <button onClick={() => fileRef.current?.click()} className="rounded-2xl bg-brand-600 text-white px-6 py-3.5 font-bold">
            Take / upload photo
          </button>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      )}

      {phase === 'analyzing' && (
        <div className="rounded-3xl bg-white p-8 shadow-sm text-center space-y-4">
          {preview && <img src={preview} alt="" className="rounded-2xl max-h-64 mx-auto" />}
          <p className="text-ink-500 animate-pulse">Counting snacks with AI…</p>
        </div>
      )}

      {(phase === 'review' || phase === 'applying') && (
        <div className="space-y-3">
          {preview && <img src={preview} alt="" className="rounded-2xl max-h-48 mx-auto" />}
          {lines.length === 0 && <p className="text-center text-ink-500">Nothing detected. Try a clearer photo.</p>}
          {lines.map((l, i) => (
            <div key={i} className={`rounded-2xl bg-white p-3 shadow-sm space-y-2 ${l.include ? '' : 'opacity-40'}`}>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={l.include} onChange={(e) => edit(i, { include: e.target.checked })} className="size-4 accent-brand-600" />
                <input
                  value={l.name}
                  onChange={(e) => edit(i, { name: e.target.value })}
                  className="grow font-medium text-sm bg-transparent outline-none"
                />
                <span className={`text-[10px] rounded-full px-2 py-0.5 ${
                  l.confidence === 'high' ? 'bg-green-50 text-green-700'
                  : l.confidence === 'medium' ? 'bg-amber-50 text-amber-700'
                  : 'bg-red-50 text-red-600'
                }`}>
                  {l.confidence}
                </span>
              </div>
              <div className="flex items-center gap-3 pl-6 text-sm">
                <span className={`rounded-full px-2 py-0.5 text-xs ${l.matched_item_id ? 'bg-blue-50 text-blue-700' : 'bg-purple-50 text-purple-700'}`}>
                  {l.matched_item_id ? 'restock' : 'new item'}
                </span>
                <label className="flex items-center gap-1">
                  qty
                  <input
                    inputMode="numeric" value={l.qty}
                    onChange={(e) => edit(i, { qty: Number(e.target.value) || 0 })}
                    className="w-14 rounded-lg bg-stone-50 border border-stone-200 px-2 py-1 text-center"
                  />
                </label>
                {!l.matched_item_id && (
                  <label className="flex items-center gap-1">
                    ₱
                    <input
                      inputMode="decimal" value={l.price}
                      onChange={(e) => edit(i, { price: e.target.value })}
                      className="w-16 rounded-lg bg-stone-50 border border-stone-200 px-2 py-1 text-center"
                    />
                  </label>
                )}
              </div>
            </div>
          ))}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button onClick={reset} className="grow rounded-2xl bg-stone-100 py-3.5 font-medium">Discard</button>
            <button
              onClick={apply}
              disabled={phase === 'applying' || lines.every((l) => !l.include)}
              className="grow rounded-2xl bg-green-600 text-white py-3.5 font-bold disabled:opacity-50"
            >
              {phase === 'applying' ? 'Applying…' : 'Apply to inventory'}
            </button>
          </div>
        </div>
      )}

      {phase === 'done' && (
        <div className="rounded-3xl bg-green-50 p-8 text-center space-y-3">
          <p className="text-4xl">✅</p>
          <p className="font-bold text-green-800">Inventory updated</p>
          <button onClick={reset} className="text-brand-600 font-medium">Scan another photo</button>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Route + verify**

Add `<Route path="restock" element={<Restock />} />`. Run `npm run build` → succeeds. As admin, upload a photo containing recognizable snacks: detections render as editable rows with matched/new badges; adjust a qty; Apply → matched items' stock increases and new items appear in `/admin/items` and the store (verify: `select name, stock from items order by name;` and `select status from restock_sessions order by created_at desc limit 1;` → `applied`).

---

### Task 14: Visual polish + full mobile E2E pass

**Files:**
- Modify: any `src/**` styling that needs it (no logic changes), `src/index.css`
- Create: `docs/screenshots/*.png`

**Interfaces:**
- Consumes: everything.
- Produces: a polished, consistent UI and a verified end-to-end flow.

- [ ] **Step 1: Design pass**

Invoke the `frontend-design:frontend-design` skill and apply its guidance across the app: consistent type scale, the brand orange used with restraint (primary actions only), consistent card radius/shadow, focus states, empty states, and a distinctive login screen. Do not change behavior, routes, or data flow. Do not introduce new fonts from external CDNs unless self-hosted.

- [ ] **Step 2: Mobile E2E checklist (375px viewport)**

Using the preview/browser tooling on the dev server, verify each and capture screenshots into `docs/screenshots/`:

1. `login.png` — login screen.
2. `store.png` — store grid, search + chips work, out-of-stock greyed.
3. `cart.png` — steppers clamp at stock, total correct.
4. `pay.png` — QR + amount; upload button states cycle.
5. `orders.png` — statuses render with correct badge colors.
6. Admin at 375px: bottom tabs; at 1280px: sidebar (`admin-mobile.png`, `admin-desktop.png`).
7. `restock-review.png` — AI restock review screen.

- [ ] **Step 3: Final verification gate**

Run: `npm run test` → all pass. Run: `npm run build` → succeeds with no TS errors. Confirm both Edge Functions are deployed (`supabase functions list`). Report any items from the checklist that could not be verified (e.g., real-payment pass path requires a genuine screenshot) rather than claiming them done.
