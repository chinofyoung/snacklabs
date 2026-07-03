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

