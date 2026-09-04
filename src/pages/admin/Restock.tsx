import { useEffect, useRef, useState } from 'react'
import { Camera, CircleCheck, PackageOpen } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { compressImage } from '../../lib/image'
import ConfirmDialog from '../../components/ConfirmDialog'
import type { Item, RestockDetection } from '../../types'

type Line = RestockDetection & { include: boolean; price: string }
type Phase = 'idle' | 'analyzing' | 'review' | 'applying' | 'done'
type CatalogItem = Pick<Item, 'id' | 'name' | 'stock' | 'price'>

async function edgeErrorMessage(err: unknown, fallback: string): Promise<string> {
  const ctx = (err as { context?: Response } | null)?.context
  if (ctx && typeof ctx.json === 'function') {
    try {
      const body = await ctx.clone().json()
      if (body?.error) return String(body.error)
    } catch { /* not JSON */ }
  }
  return err instanceof Error ? err.message : fallback
}

// The AI's matched_item_id can hallucinate an id that doesn't exist in the
// catalog. Resolving it at every read site (instead of trusting the raw
// field) keeps a bad id from ever reaching apply_restock as a no-op update.
function resolveMatch(matchedItemId: string | null, catalog: CatalogItem[], catalogLoaded: boolean) {
  const matchedItem = matchedItemId ? catalog.find((c) => c.id === matchedItemId) ?? null : null
  const aiMatchUnknown = catalogLoaded && matchedItemId != null && !matchedItem
  return { matchedItem, aiMatchUnknown }
}

function pluralize(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

// Kept local (not in src/lib) because this task is scoped to editing only
// this file — a shared helper + vitest test would require a second file.
function applySummary(lines: Line[], catalog: CatalogItem[], catalogLoaded: boolean): string {
  const included = lines.filter((l) => l.include && l.qty > 0)
  const restockCount = included.filter((l) => resolveMatch(l.matched_item_id, catalog, catalogLoaded).matchedItem).length
  const newCount = included.length - restockCount
  const parts: string[] = []
  if (restockCount > 0) parts.push(`${pluralize(restockCount, 'item')} will be restocked`)
  if (newCount > 0) parts.push(`${pluralize(newCount, 'new item')} will be created`)
  return parts.length > 0 ? `${parts.join(' and ')}.` : 'No items will be applied.'
}

export default function Restock() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [preview, setPreview] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [catalog, setCatalog] = useState<CatalogItem[]>([])
  const [catalogLoaded, setCatalogLoaded] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)

  useEffect(() => {
    let cancelled = false
    supabase.from('items').select('id, name, stock, price').eq('is_active', true).order('name')
      .then(({ data, error: fetchErr }) => {
        if (cancelled) return
        if (fetchErr) {
          setError(fetchErr.message)
        } else {
          setCatalog((data ?? []) as CatalogItem[])
        }
        setCatalogLoaded(true)
      })
    return () => { cancelled = true }
  }, [])

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
      if (fnErr) throw new Error(await edgeErrorMessage(fnErr, 'Analysis failed'))
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

  const apply = async (): Promise<boolean> => {
    setPhase('applying')
    setError(null)
    const payload = lines
      .filter((l) => l.include && l.qty > 0)
      .map((l) => ({
        item_id: resolveMatch(l.matched_item_id, catalog, catalogLoaded).matchedItem?.id ?? null,
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
      return false
    }
    setPhase('done')
    return true
  }

  const confirmApply = async () => {
    const ok = await apply()
    if (ok) setShowConfirm(false)
  }

  const reset = () => {
    setPhase('idle'); setLines([]); setSessionId(null); setPreview(null); setError(null); setShowConfirm(false)
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
          {lines.map((l, i) => {
            const { matchedItem, aiMatchUnknown } = resolveMatch(l.matched_item_id, catalog, catalogLoaded)
            return (
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
              <div className="flex flex-wrap items-center gap-3 pl-6 text-sm">
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${matchedItem ? 'bg-blue-50 text-blue-700' : 'bg-purple-50 text-purple-700'}`}>
                  {matchedItem ? 'restock' : 'new item'}
                </span>
                {matchedItem && (
                  <span className="text-xs text-ink-500">
                    {matchedItem.name}{' '}
                    <span className="tabular-nums">{matchedItem.stock} → {matchedItem.stock + l.qty}</span>
                  </span>
                )}
                {aiMatchUnknown && (
                  <span className="text-[10px] text-ink-400 italic">AI suggested an item not in your catalog</span>
                )}
                <select
                  value={l.matched_item_id ?? ''}
                  onChange={(e) => edit(i, { matched_item_id: e.target.value || null })}
                  aria-label={`Match ${l.name} to inventory item`}
                  className="rounded-md bg-surface border border-line px-2 py-1 text-sm outline-none focus-visible:outline-2 focus-visible:outline-brand-500"
                >
                  <option value="">+ Create as new item</option>
                  {catalog.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                <label className="flex items-center gap-1">
                  qty
                  <input
                    inputMode="numeric" value={l.qty}
                    onChange={(e) => edit(i, { qty: Number(e.target.value) || 0 })}
                    className="w-14 rounded-md bg-surface border border-line px-2 py-1 text-center outline-none focus-visible:outline-2 focus-visible:outline-brand-500"
                  />
                </label>
                {!matchedItem && (
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
            )
          })}
          {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
          <div className="flex gap-2">
            <button onClick={reset} className="grow rounded-lg bg-ink-900/5 py-3.5 font-medium">Discard</button>
            <button
              onClick={() => setShowConfirm(true)}
              disabled={phase === 'applying' || lines.every((l) => !l.include)}
              className="grow rounded-lg bg-green-600 text-white py-3.5 font-bold disabled:opacity-50"
            >
              {phase === 'applying' ? 'Applying…' : 'Apply to inventory'}
            </button>
          </div>
          <ConfirmDialog
            open={showConfirm}
            title="Apply to inventory?"
            message={applySummary(lines, catalog, catalogLoaded)}
            confirmLabel="Apply"
            busy={phase === 'applying'}
            busyLabel="Applying…"
            onConfirm={confirmApply}
            onCancel={() => setShowConfirm(false)}
          />
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
