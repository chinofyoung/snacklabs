import { useRef, useState } from 'react'
import { Camera, CircleCheck, PackageOpen } from 'lucide-react'
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
      <h1 className="font-display text-2xl font-bold flex items-center gap-2">
        <Camera className="size-6" strokeWidth={2.5} aria-hidden="true" />
        AI Restock
      </h1>
      <input
        ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden"
        onChange={(e) => e.target.files?.[0] && analyze(e.target.files[0])}
      />

      {phase === 'idle' && (
        <div className="rounded-xl bg-surface-raised p-8 shadow-card text-center space-y-4">
          <PackageOpen className="size-14 mx-auto text-brand-600" strokeWidth={2.5} aria-hidden="true" />
          <p className="text-ink-500 text-sm">
            Snap a photo of the shelf or a new delivery.<br />
            Claude will count items and match them to your catalog.
          </p>
          <button onClick={() => fileRef.current?.click()} className="rounded-lg bg-brand-600 text-white px-6 py-3.5 font-bold">
            Take / upload photo
          </button>
          {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
        </div>
      )}

      {phase === 'analyzing' && (
        <div className="rounded-xl bg-surface-raised p-8 shadow-card text-center space-y-4">
          {preview && <img src={preview} alt="" className="rounded-md max-h-64 mx-auto" />}
          <p className="text-ink-500 animate-pulse">Counting snacks with AI…</p>
        </div>
      )}

      {(phase === 'review' || phase === 'applying') && (
        <div className="space-y-3">
          {preview && <img src={preview} alt="" className="rounded-md max-h-48 mx-auto" />}
          {lines.length === 0 && <p className="text-center text-ink-500">Nothing detected. Try a clearer photo.</p>}
          {lines.map((l, i) => (
            <div key={i} className={`rounded-lg bg-surface-raised p-3 shadow-card space-y-2 ${l.include ? '' : 'opacity-40'}`}>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={l.include} onChange={(e) => edit(i, { include: e.target.checked })} aria-label={`Include ${l.name}`} className="size-4 accent-brand-600" />
                <input
                  value={l.name}
                  onChange={(e) => edit(i, { name: e.target.value })}
                  aria-label="Item name"
                  className="grow font-medium text-sm bg-transparent outline-none rounded-md"
                />
                <span className={`text-[10px] rounded-full px-2 py-0.5 font-medium ${
                  l.confidence === 'high' ? 'bg-green-50 text-green-700'
                  : l.confidence === 'medium' ? 'bg-amber-50 text-amber-700'
                  : 'bg-red-50 text-red-600'
                }`}>
                  {l.confidence}
                </span>
              </div>
              <div className="flex items-center gap-3 pl-6 text-sm">
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${l.matched_item_id ? 'bg-blue-50 text-blue-700' : 'bg-purple-50 text-purple-700'}`}>
                  {l.matched_item_id ? 'restock' : 'new item'}
                </span>
                <label className="flex items-center gap-1">
                  qty
                  <input
                    inputMode="numeric" value={l.qty}
                    onChange={(e) => edit(i, { qty: Number(e.target.value) || 0 })}
                    className="w-14 rounded-md bg-surface border border-line px-2 py-1 text-center outline-none focus-visible:outline-2 focus-visible:outline-brand-500"
                  />
                </label>
                {!l.matched_item_id && (
                  <label className="flex items-center gap-1">
                    ₱
                    <input
                      inputMode="decimal" value={l.price}
                      onChange={(e) => edit(i, { price: e.target.value })}
                      className="w-16 rounded-md bg-surface border border-line px-2 py-1 text-center outline-none focus-visible:outline-2 focus-visible:outline-brand-500"
                    />
                  </label>
                )}
              </div>
            </div>
          ))}
          {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
          <div className="flex gap-2">
            <button onClick={reset} className="grow rounded-lg bg-ink-900/5 py-3.5 font-medium">Discard</button>
            <button
              onClick={apply}
              disabled={phase === 'applying' || lines.every((l) => !l.include)}
              className="grow rounded-lg bg-green-600 text-white py-3.5 font-bold disabled:opacity-50"
            >
              {phase === 'applying' ? 'Applying…' : 'Apply to inventory'}
            </button>
          </div>
        </div>
      )}

      {phase === 'done' && (
        <div className="rounded-xl bg-green-50 p-8 text-center space-y-3">
          <CircleCheck className="size-12 mx-auto text-green-700" strokeWidth={2.5} aria-hidden="true" />
          <p className="font-bold text-green-800">Inventory updated</p>
          <button onClick={reset} className="text-brand-600 font-semibold rounded-md">Scan another photo</button>
        </div>
      )}
    </div>
  )
}
