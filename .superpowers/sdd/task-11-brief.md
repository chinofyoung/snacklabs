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

