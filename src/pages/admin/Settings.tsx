import { useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import type { AppSettings } from '../../types'
import PushToggle from '../../components/PushToggle'
import PaymentMethods from './Payments'

const MODELS: { value: AppSettings['payment_ai_model']; label: string; hint: string }[] = [
  { value: 'claude-haiku-4-5', label: 'Haiku', hint: 'cheapest (~₱0.15/check)' },
  { value: 'claude-sonnet-5', label: 'Sonnet', hint: 'balanced (~₱0.7/check)' },
  { value: 'claude-opus-4-8', label: 'Opus', hint: 'most accurate (~₱1.2/check)' },
]

export default function Settings() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    supabase.from('app_settings').select('*').single()
      .then(({ data, error: err }) => {
        if (err) {
          setError(err.message)
          return
        }
        setSettings(data as AppSettings)
      })
  }, [])

  const save = async () => {
    if (!settings) return
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const { error: err } = await supabase.from('app_settings').update({
        payment_ai_enabled: settings.payment_ai_enabled,
        payment_ai_model: settings.payment_ai_model,
        updated_at: new Date().toISOString(),
      }).eq('id', true)
      if (err) throw err
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-3xl">
      <h1 className="font-display text-2xl font-bold">Settings</h1>

      <section className="rounded-2xl bg-surface-raised shadow-sm p-4 md:p-5 space-y-4">
        <h2 className="font-display text-lg font-bold flex items-center gap-1.5">
          <Sparkles className="size-5 text-brand-600" strokeWidth={2.5} aria-hidden="true" />
          AI payment verification
        </h2>

        {!settings ? (
          <p className="text-sm text-ink-500">Loading…</p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-medium text-sm">Verify payments with AI</p>
                {!settings.payment_ai_enabled && (
                  <p className="text-xs text-ink-500 mt-0.5">
                    Payments will skip AI and go straight to the review queue for manual approval.
                  </p>
                )}
              </div>
              <button
                role="switch"
                aria-checked={settings.payment_ai_enabled}
                aria-label="Verify payments with AI"
                onClick={() => setSettings({ ...settings, payment_ai_enabled: !settings.payment_ai_enabled })}
                className={`shrink-0 w-12 h-7 rounded-full transition relative ${settings.payment_ai_enabled ? 'bg-brand-600' : 'bg-ink-500'}`}
              >
                <span
                  className={`absolute top-0.5 size-6 rounded-full bg-white shadow transition ${settings.payment_ai_enabled ? 'left-[calc(100%-1.625rem)]' : 'left-0.5'}`}
                />
              </button>
            </div>

            <div className={`space-y-2 ${settings.payment_ai_enabled ? '' : 'opacity-40 pointer-events-none'}`}>
              <p className="text-xs font-medium text-ink-500">Model</p>
              <div className="grid grid-cols-3 gap-2">
                {MODELS.map((m) => (
                  <button
                    key={m.value}
                    disabled={!settings.payment_ai_enabled}
                    onClick={() => setSettings({ ...settings, payment_ai_model: m.value })}
                    className={`rounded-md py-2.5 px-2 text-center text-sm font-medium space-y-0.5 ${
                      settings.payment_ai_model === m.value ? 'bg-ink-900 text-white' : 'bg-ink-900/5'
                    }`}
                  >
                    <span className="block">{m.label}</span>
                    <span className={`block text-[10px] font-normal ${settings.payment_ai_model === m.value ? 'text-white/70' : 'text-ink-500'}`}>
                      {m.hint}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {error && <p className="text-sm text-red-600" role="alert">{error}</p>}

            <div className="flex items-center gap-3 pt-1">
              <button
                onClick={save}
                disabled={saving}
                className="rounded-md bg-brand-700 text-white px-4 py-2 font-medium disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              {saved && <span className="text-sm text-green-600 font-medium">Saved</span>}
            </div>
          </>
        )}
      </section>

      <section className="rounded-2xl bg-surface-raised shadow-sm p-4 md:p-5">
        <PushToggle />
      </section>

      <section className="rounded-2xl bg-surface-raised shadow-sm p-4 md:p-5">
        <PaymentMethods />
      </section>
    </div>
  )
}
