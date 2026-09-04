import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { Camera, CupSoda, LayoutGrid, List, ShoppingBasket, X } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { formatPeso } from '../../lib/money'
import { compressImage } from '../../lib/image'
import type { Item } from '../../types'
import ImageUploadField from '../../components/ImageUploadField'
import ConfirmDialog from '../../components/ConfirmDialog'
import CameraAiMark from '../../components/CameraAiMark'

type Draft = {
  id?: string
  name: string
  price: string
  stock: string
  category: string
  low_stock_threshold: string
  file?: File | null
  image_url?: string | null
}

type ItemsView = 'list' | 'grid'

const EMPTY: Draft = { name: '', price: '', stock: '0', category: 'snacks', low_stock_threshold: '3', file: null, image_url: null }
const VIEW_STORAGE_KEY = 'snacklabs.admin.itemsView'

export default function Items() {
  const navigate = useNavigate()
  const fileRef = useRef<HTMLInputElement>(null)
  const [items, setItems] = useState<Item[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Item | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [view, setView] = useState<ItemsView>(() => {
    try {
      const stored = localStorage.getItem(VIEW_STORAGE_KEY)
      return stored === 'list' || stored === 'grid' ? stored : 'list'
    } catch {
      return 'list'
    }
  })

  useEffect(() => {
    localStorage.setItem(VIEW_STORAGE_KEY, view)
  }, [view])

  const load = () =>
    supabase.from('items').select('*').eq('is_active', true).order('name')
      .then(({ data }) => setItems((data as Item[]) ?? []))

  useEffect(() => { load() }, [])

  const adjustStock = async (item: Item, delta: number) => {
    setError(null)
    const next = Math.max(0, item.stock + delta)
    setItems((all) => all.map((i) => (i.id === item.id ? { ...i, stock: next } : i)))
    const { error: upErr } = await supabase.from('items').update({ stock: next }).eq('id', item.id)
    if (upErr) {
      setError(`Stock update failed: ${upErr.message}`)
      await load()
    }
  }

  const openEditDraft = (i: Item) => setDraft({
    id: i.id, name: i.name, price: String(i.price), stock: String(i.stock),
    category: i.category, low_stock_threshold: String(i.low_stock_threshold), file: null,
    image_url: i.image_url,
  })

  const save = async () => {
    if (!draft) return
    setSaving(true)
    setError(null)
    try {
      // Validate before uploading
      const name = draft.name.trim()
      const price = Number(draft.price)
      const stock = Math.trunc(Number(draft.stock))
      const low = Math.trunc(Number(draft.low_stock_threshold))
      if (!name) throw new Error('Name is required')
      if (!Number.isFinite(price) || price < 0) throw new Error('Price must be a number ≥ 0')
      if (!Number.isFinite(stock) || stock < 0) throw new Error('Stock must be a whole number ≥ 0')
      if (!Number.isFinite(low) || low < 0) throw new Error('Low stock alert must be a whole number ≥ 0')

      let uploadedImageUrl: string | undefined
      if (draft.file) {
        const blob = await compressImage(draft.file, 800)
        const path = `${crypto.randomUUID()}.jpg`
        const { error: upErr } = await supabase.storage
          .from('item-images').upload(path, blob, { contentType: 'image/jpeg' })
        if (upErr) throw upErr
        uploadedImageUrl = supabase.storage.from('item-images').getPublicUrl(path).data.publicUrl
      }
      const payload = {
        name,
        price,
        stock,
        category: draft.category.trim() || 'snacks',
        low_stock_threshold: low,
        ...(uploadedImageUrl ? { image_url: uploadedImageUrl } : {}),
      }
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
    setDeleting(true)
    setError(null)
    const { error: delErr } = await supabase.from('items').update({ is_active: false }).eq('id', item.id)
    setDeleting(false)
    if (delErr) {
      setError(`Remove failed: ${delErr.message}`)
      return
    }
    setPendingDelete(null)
    await load()
  }

  return (
    <div className="p-4 md:p-8 space-y-4 max-w-3xl">
      <input
        ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) setDraft({ ...EMPTY, file: f })
          e.target.value = ''
        }}
      />
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="font-display text-2xl font-bold">Items</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setDraft({ ...EMPTY })}
            className="rounded-md bg-brand-600 text-white px-4 py-2 font-medium"
          >
            + Add item
          </button>
          <button
            onClick={() => fileRef.current?.click()}
            aria-label="Add item from photo"
            className="rounded-md bg-brand-600 text-white p-2.5"
          >
            <Camera className="size-5" strokeWidth={2.5} aria-hidden="true" />
          </button>
          <button
            onClick={() => navigate('/admin/restock')}
            aria-label="AI restock"
            className="rounded-md bg-brand-600 text-white p-2.5"
          >
            <CameraAiMark className="size-5" strokeWidth={2.5} />
          </button>
        </div>
      </div>

      <div className="flex justify-end">
        <div className="rounded-full bg-surface-raised shadow-card p-1 flex gap-1">
          <button
            onClick={() => setView('list')}
            aria-label="List view"
            aria-pressed={view === 'list'}
            className={`size-8 rounded-full flex items-center justify-center transition ${view === 'list' ? 'bg-ink-900 text-white' : 'text-ink-500'}`}
          >
            <List className="size-4" strokeWidth={2.5} aria-hidden="true" />
          </button>
          <button
            onClick={() => setView('grid')}
            aria-label="Grid view"
            aria-pressed={view === 'grid'}
            className={`size-8 rounded-full flex items-center justify-center transition ${view === 'grid' ? 'bg-ink-900 text-white' : 'text-ink-500'}`}
          >
            <LayoutGrid className="size-4" strokeWidth={2.5} aria-hidden="true" />
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}

      {items.length === 0 ? (
        <div className="text-center py-12 space-y-2">
          <CupSoda className="size-12 mx-auto text-ink-500" strokeWidth={2.5} aria-hidden="true" />
          <p className="text-ink-700 font-medium">No items yet</p>
          <p className="text-ink-500 text-sm">Add your first snack to stock the shelf.</p>
        </div>
      ) : view === 'list' ? (
        <div className="space-y-2">
          {items.map((i) => (
            <div key={i.id} className="rounded-lg bg-surface-raised p-3 shadow-card flex items-center gap-3">
              <div className="size-12 rounded-md bg-brand-50 overflow-hidden flex items-center justify-center shrink-0">
                {i.image_url ? <img src={i.image_url} alt="" className="w-full h-full object-cover" /> : <ShoppingBasket className="size-6 text-brand-600/40" strokeWidth={2.5} aria-hidden="true" />}
              </div>
              <div className="grow min-w-0">
                <p className="font-medium text-sm truncate">{i.name}</p>
                <p className="text-xs text-ink-500">{formatPeso(i.price)} · {i.category}</p>
              </div>
              <div className="flex items-center gap-1.5">
                <button onClick={() => adjustStock(i, -1)} aria-label={`Decrease ${i.name} stock`} className="size-8 rounded-full bg-ink-900/5 font-bold">−</button>
                <span className={`w-8 text-center font-bold text-sm tabular-nums ${i.stock <= i.low_stock_threshold ? 'text-amber-600' : ''}`}>
                  {i.stock}
                </span>
                <button onClick={() => adjustStock(i, 1)} aria-label={`Increase ${i.name} stock`} className="size-8 rounded-full bg-ink-900/5 font-bold">+</button>
              </div>
              <button
                onClick={() => openEditDraft(i)}
                className="text-sm text-ink-500 px-1.5 py-1 rounded-md"
              >
                Edit
              </button>
              <button onClick={() => setPendingDelete(i)} aria-label={`Remove ${i.name}`} className="text-red-500 px-1.5 py-1 rounded-md"><X className="size-4" strokeWidth={2.5} aria-hidden="true" /></button>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {items.map((i) => (
            <div key={i.id} className="rounded-lg bg-surface-raised shadow-card overflow-hidden flex flex-col">
              <div className="aspect-square bg-brand-50 flex items-center justify-center overflow-hidden">
                {i.image_url ? <img src={i.image_url} alt="" className="w-full h-full object-cover" /> : <ShoppingBasket className="size-8 text-brand-600/40" strokeWidth={2.5} aria-hidden="true" />}
              </div>
              <div className="p-3 space-y-2 grow flex flex-col">
                <p className="font-medium text-sm line-clamp-2">{i.name}</p>
                <p className="text-xs text-ink-500">{formatPeso(i.price)} · {i.category}</p>
                <div className="mt-auto space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <button onClick={() => adjustStock(i, -1)} aria-label={`Decrease ${i.name} stock`} className="size-8 rounded-full bg-ink-900/5 font-bold">−</button>
                    <span className={`w-8 text-center font-bold text-sm tabular-nums ${i.stock <= i.low_stock_threshold ? 'text-amber-600' : ''}`}>
                      {i.stock}
                    </span>
                    <button onClick={() => adjustStock(i, 1)} aria-label={`Increase ${i.name} stock`} className="size-8 rounded-full bg-ink-900/5 font-bold">+</button>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <button onClick={() => openEditDraft(i)} className="text-sm text-ink-500 px-1.5 py-1 rounded-md">Edit</button>
                    <button onClick={() => setPendingDelete(i)} aria-label={`Remove ${i.name}`} className="text-red-500 px-1.5 py-1 rounded-md"><X className="size-4" strokeWidth={2.5} aria-hidden="true" /></button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {draft && (
        <div className="fixed inset-0 z-20 bg-ink-900/40 flex items-end md:items-center justify-center" onClick={() => setDraft(null)}>
          <div className="bg-surface-raised rounded-t-xl md:rounded-xl w-full max-w-md p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-display font-bold text-lg">{draft.id ? 'Edit item' : 'New item'}</h2>
            <Field label="Name"><input className={inputCls} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Price (₱)"><input className={inputCls} inputMode="decimal" value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} /></Field>
              <Field label="Stock"><input className={inputCls} inputMode="numeric" value={draft.stock} onChange={(e) => setDraft({ ...draft, stock: e.target.value })} /></Field>
              <Field label="Category"><input className={inputCls} value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} /></Field>
              <Field label="Low stock alert"><input className={inputCls} inputMode="numeric" value={draft.low_stock_threshold} onChange={(e) => setDraft({ ...draft, low_stock_threshold: e.target.value })} /></Field>
            </div>
            <ImageUploadField
              label="Photo"
              file={draft.file ?? null}
              currentUrl={draft.image_url}
              onChange={(f) => setDraft({ ...draft, file: f })}
            />
            {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
            <div className="flex gap-2 pt-1">
              <button onClick={() => setDraft(null)} className="grow rounded-md bg-ink-900/5 py-3 font-medium">Cancel</button>
              <button onClick={save} disabled={saving} className="grow rounded-md bg-ink-900 text-white py-3 font-medium disabled:opacity-50">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        destructive
        title="Remove item?"
        message={<>Remove <b>{pendingDelete?.name}</b> from the store? It will no longer appear on the shelf.</>}
        confirmLabel="Remove"
        busy={deleting}
        busyLabel="Removing…"
        onConfirm={() => pendingDelete && deactivate(pendingDelete)}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  )
}

const inputCls = 'w-full rounded-md bg-surface border border-line px-3 py-2.5 text-sm outline-none focus-visible:outline-2 focus-visible:outline-brand-500'
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-xs font-medium text-ink-500">{label}</span>
      {children}
    </label>
  )
}
