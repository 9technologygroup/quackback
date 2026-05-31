import { useEffect, useRef, useState } from 'react'
import { FaceSmileIcon } from '@heroicons/react/24/outline'
import { cn } from '@/lib/shared/utils'

// A small curated set keeps this dependency-free; covers the common chat range.
const EMOJIS = [
  '😀',
  '😁',
  '😂',
  '🤣',
  '😊',
  '😍',
  '😎',
  '🤔',
  '😅',
  '🙂',
  '😉',
  '😇',
  '🥳',
  '😴',
  '😢',
  '😭',
  '😡',
  '🤯',
  '👍',
  '👎',
  '👏',
  '🙌',
  '🙏',
  '🤝',
  '💪',
  '👀',
  '🎉',
  '🔥',
  '💯',
  '✅',
  '❌',
  '⚠️',
  '❤️',
  '💔',
  '💡',
  '🚀',
  '⭐',
  '🐛',
  '📎',
  '🤷',
]

/**
 * Minimal emoji inserter: a toggle button with a popover grid. Closes on
 * outside click or after a pick. Works inside the widget iframe (no portal).
 */
export function EmojiPicker({
  onSelect,
  className,
}: {
  onSelect: (emoji: string) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted transition-colors"
        aria-label="Insert emoji"
        aria-expanded={open}
      >
        <FaceSmileIcon className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-2 grid grid-cols-8 gap-0.5 rounded-lg border border-border bg-background p-1.5 shadow-md">
          {EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => {
                onSelect(emoji)
                setOpen(false)
              }}
              className="rounded p-1 text-lg leading-none hover:bg-muted"
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
