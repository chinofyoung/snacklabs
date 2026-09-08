import { useEffect, useRef, useState } from 'react'
import { ImagePlus, X } from 'lucide-react'

type ImageUploadFieldProps = {
  label: string
  file: File | null
  onChange: (file: File | null) => void
  currentUrl?: string | null
  accept?: string
}

function formatFileSize(bytes: number) {
  const KB = 1024
  const MB = 1024 * 1024
  if (bytes < MB) return `${Math.round(bytes / KB)} KB`
  return `${(bytes / MB).toFixed(1)} MB`
}

export default function ImageUploadField({
  label,
  file,
  onChange,
  currentUrl = null,
  accept = 'image/*',
}: ImageUploadFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null)
      return
    }
    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const openPicker = () => inputRef.current?.click()

  const remove = () => {
    onChange(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <div>
      <span className="block text-xs font-medium text-ink-500 mb-1">{label}</span>
      <input
        type="file"
        accept={accept}
        className="hidden"
        ref={inputRef}
        onChange={(e) => onChange(e.target.files?.[0] ?? null)}
      />

      {file ? (
        <div className="flex items-center gap-3">
          <img src={previewUrl ?? undefined} className="size-12 rounded-md object-cover shrink-0" alt="" />
          <div className="min-w-0 grow">
            <p className="text-sm truncate">{file.name}</p>
            <p className="text-xs text-ink-500">{formatFileSize(file.size)}</p>
          </div>
          <button type="button" onClick={openPicker} className="text-sm text-ink-500 px-1.5 py-1 rounded-md">
            Change
          </button>
          <button type="button" onClick={remove} aria-label="Remove photo" className="text-red-500 px-1.5 py-1 rounded-md">
            <X className="size-4" strokeWidth={2.5} aria-hidden="true" />
          </button>
        </div>
      ) : currentUrl ? (
        <div className="flex items-center gap-3">
          <img src={currentUrl} className="size-12 rounded-md object-cover shrink-0" alt="" />
          <div className="min-w-0 grow">
            <p className="text-sm text-ink-500">Current photo</p>
          </div>
          <button type="button" onClick={openPicker} className="text-sm text-ink-500 px-1.5 py-1 rounded-md">
            Change
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={openPicker}
          className="w-full rounded-md border border-dashed border-line bg-surface px-3 py-4 flex items-center justify-center gap-2 text-sm text-ink-500 hover:border-brand-500 hover:text-brand-700 transition"
        >
          <ImagePlus className="size-5" strokeWidth={2.5} aria-hidden="true" />
          Choose photo
        </button>
      )}
    </div>
  )
}
