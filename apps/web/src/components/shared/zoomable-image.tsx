import { useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'

/**
 * An image thumbnail that opens a near-full-size preview in a modal on click.
 * Shared by the composer attachment tray and sent-message attachments so chat
 * images behave the same everywhere (thumbnail + click-to-enlarge).
 */
export function ZoomableImage({
  src,
  alt,
  className,
  thumbClassName,
}: {
  src: string
  alt?: string
  /** Class for the clickable thumbnail button. */
  className?: string
  /** Class for the <img> inside the thumbnail. */
  thumbClassName?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={alt ? `Enlarge ${alt}` : 'Enlarge image'}
        className={className}
      >
        <img src={src} alt={alt ?? ''} loading="lazy" className={thumbClassName} />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        {/* No visible header — just the image with the built-in corner X. The
            title stays for screen readers only. */}
        <DialogContent className="max-w-3xl p-2">
          <DialogTitle className="sr-only">{alt || 'Image preview'}</DialogTitle>
          <img
            src={src}
            alt={alt ?? ''}
            className="max-h-[85vh] w-full rounded-md object-contain"
          />
        </DialogContent>
      </Dialog>
    </>
  )
}
