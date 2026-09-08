import { useEffect, useState } from 'react'
import { Banknote, CreditCard, Landmark, Smartphone } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { compressImage } from '../../lib/image'
import type { PaymentMethod } from '../../types'
import ImageUploadField from '../../components/ImageUploadField'

type Draft = {
  id?: string
  label: string
  type: 'ewallet' | 'bank' | 'cash'
  account_name: string
  account_number: string
  file?: File | null
  existing_qr?: string | null
}

const EMPTY: Draft = { label: '', type: 'ewallet', account_name: '', account_number: '', file: null }

export default function PaymentMethods() {
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
      // Validate before uploading
      const label = draft.label.trim()
      const account_name = draft.account_name.trim()
      if (!label) throw new Error('Label is required')
      if (!account_name) throw new Error('Account name is required')
      if (draft.type !== 'cash' && !draft.id && !draft.file) throw new Error('A QR code image is required')

      let qr_image_url: string | null = draft.type === 'cash' ? null : (draft.existing_qr ?? null)
      if (draft.type !== 'cash' && draft.file) {
        const blob = await compressImage(draft.file, 1000, 0.9)
        const path = `${crypto.randomUUID()}.jpg`
        const { error: upErr } = await supabase.storage
          .from('qr-codes').upload(path, blob, { contentType: 'image/jpeg' })
        if (upErr) throw upErr
        qr_image_url = supabase.storage.from('qr-codes').getPublicUrl(path).data.publicUrl
      }
      const payload = {
        label,
        type: draft.type,
        account_name,
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
    setError(null)
    const { error: upErr } = await supabase.from('payment_methods').update({ is_active: !m.is_active }).eq('id', m.id)
    if (upErr) {
      setError(`Toggle failed: ${upErr.message}`)
      return
    }
    await load()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-lg font-bold">Payment methods</h2>
        <button onClick={() => setDraft({ ...EMPTY })} className="rounded-md bg-brand-700 text-white px-4 py-2 font-medium">
          + Add
        </button>
      </div>

      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}

      {methods.length === 0 ? (
        <div className="text-center py-12 space-y-2">
          <CreditCard className="size-12 mx-auto text-ink-500" strokeWidth={2.5} aria-hidden="true" />
          <p className="text-ink-700 font-medium">No payment methods yet</p>
          <p className="text-ink-500 text-sm">Add one so customers can pay for orders.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {methods.map((m) => (
            <div key={m.id} className={`rounded-lg bg-surface-raised p-3 shadow-card flex items-center gap-3 ${m.is_active ? '' : 'opacity-50'}`}>
              {m.qr_image_url ? (
                <img src={m.qr_image_url} alt="" className="size-12 rounded-md object-cover" />
              ) : (
                <div className="size-12 rounded-md bg-brand-50 flex items-center justify-center shrink-0">
                  <Banknote className="size-6 text-brand-600/60" strokeWidth={2.5} aria-hidden="true" />
                </div>
              )}
              <div className="grow">
                <p className="font-medium text-sm flex items-center gap-1.5">
                  {m.type === 'ewallet' && <Smartphone className="size-5" strokeWidth={2.5} aria-hidden="true" />}
                  {m.type === 'bank' && <Landmark className="size-5" strokeWidth={2.5} aria-hidden="true" />}
                  {m.type === 'cash' && <Banknote className="size-5" strokeWidth={2.5} aria-hidden="true" />}
                  {m.label}
                </p>
                <p className="text-xs text-ink-500">{m.account_name} {m.account_number && `· ${m.account_number}`}</p>
              </div>
              <button onClick={() => toggle(m)} className="text-sm text-ink-500 px-1.5 py-1 rounded-md">
                {m.is_active ? 'Disable' : 'Enable'}
              </button>
              <button
                onClick={() => setDraft({
                  id: m.id, label: m.label, type: m.type, account_name: m.account_name,
                  account_number: m.account_number, file: null, existing_qr: m.qr_image_url,
                })}
                className="text-sm text-ink-500 px-1.5 py-1 rounded-md"
              >
                Edit
              </button>
            </div>
          ))}
        </div>
      )}

      {draft && (
        <div className="fixed inset-0 z-20 bg-ink-900/40 flex items-end md:items-center justify-center" onClick={() => setDraft(null)}>
          <div className="bg-surface-raised rounded-t-xl md:rounded-xl w-full max-w-md p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-display font-bold text-lg">{draft.id ? 'Edit method' : 'New payment method'}</h2>
            <label className="block space-y-1">
              <span className="block text-xs font-medium text-ink-500">Label (e.g. GCash, BPI)</span>
              <input className={inputCls} value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
            </label>
            <div className="flex gap-2">
              {(['ewallet', 'bank', 'cash'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setDraft({ ...draft, type: t })}
                  className={`grow rounded-md py-2.5 text-sm font-medium flex items-center justify-center gap-1.5 ${draft.type === t ? 'bg-ink-900 text-white' : 'bg-ink-900/5'}`}
                >
                  {t === 'ewallet' && <Smartphone className="size-5" strokeWidth={2.5} aria-hidden="true" />}
                  {t === 'bank' && <Landmark className="size-5" strokeWidth={2.5} aria-hidden="true" />}
                  {t === 'cash' && <Banknote className="size-5" strokeWidth={2.5} aria-hidden="true" />}
                  {t === 'ewallet' ? 'E-wallet' : t === 'bank' ? 'Bank' : 'Cash'}
                </button>
              ))}
            </div>
            <label className="block space-y-1">
              <span className="block text-xs font-medium text-ink-500">
                {draft.type === 'cash' ? 'Label / where to pay' : 'Account name'}
              </span>
              <input className={inputCls} value={draft.account_name} onChange={(e) => setDraft({ ...draft, account_name: e.target.value })} />
            </label>
            {draft.type !== 'cash' && (
              <label className="block space-y-1">
                <span className="block text-xs font-medium text-ink-500">Account / mobile number</span>
                <input className={inputCls} value={draft.account_number} onChange={(e) => setDraft({ ...draft, account_number: e.target.value })} />
              </label>
            )}
            {draft.type === 'cash' ? (
              <p className="text-xs text-ink-500">No QR needed for cash.</p>
            ) : (
              <ImageUploadField
                label="QR code image"
                file={draft.file ?? null}
                currentUrl={draft.existing_qr}
                onChange={(f) => setDraft({ ...draft, file: f })}
              />
            )}
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
    </div>
  )
}

const inputCls = 'w-full rounded-md bg-surface border border-line px-3 py-2.5 text-sm outline-none focus-visible:outline-2 focus-visible:outline-brand-700'
