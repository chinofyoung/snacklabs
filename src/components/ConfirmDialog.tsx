import { useEffect, useId, useRef, useState } from 'react'

type ConfirmDialogProps = {
  open: boolean
  title: string
  message: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  busy?: boolean
  busyLabel?: string
  requireTyped?: string
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  busy = false,
  busyLabel = 'Working…',
  requireTyped,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId()
  const typedId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [typed, setTyped] = useState('')

  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, busy, onCancel])

  useEffect(() => {
    if (open) {
      setTyped('')
      cancelRef.current?.focus()
    }
  }, [open])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-30 bg-ink-900/40 flex items-end md:items-center justify-center p-4"
      onClick={() => { if (!busy) onCancel() }}
    >
      <div
        className="bg-surface-raised rounded-xl w-full max-w-md p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h2 id={titleId} className="font-display font-bold text-lg">{title}</h2>
        <div className="text-sm text-ink-500">{message}</div>
        {requireTyped != null && (
          <div className="space-y-1">
            <label htmlFor={typedId} className="block text-xs font-medium text-ink-500">Type {requireTyped} to confirm</label>
            <input
              id={typedId}
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="w-full rounded-md bg-surface border border-line px-3 py-2.5 text-sm outline-none focus-visible:outline-2 focus-visible:outline-brand-700"
            />
          </div>
        )}
        <div className="flex gap-2 pt-1">
          <button
            ref={cancelRef}
            onClick={onCancel}
            disabled={busy}
            className="grow rounded-md bg-ink-900/5 py-3 font-medium disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            disabled={busy || (requireTyped != null && typed.trim() !== requireTyped)}
            className={`grow rounded-md ${destructive ? 'bg-red-600' : 'bg-ink-900'} text-white py-3 font-medium disabled:opacity-50`}
          >
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
