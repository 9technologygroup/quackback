/**
 * The internal-sources leak gate (COPILOT-SIDEBAR-UX.md B.4), shared by the
 * Copilot panel and the proactive suggested-reply card: any internal-sourced
 * answer must clear this hard confirm before it can reach a customer-facing
 * composer. One component owns the safety copy so the wording can never
 * drift between the two surfaces; only the subject noun, the confirm label,
 * and whether an "Add as note" escape hatch exists (the panel has one — a
 * note is never customer-facing, so it never confirms) vary per host.
 */
import { Button, buttonVariants } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

export function InternalSourcesConfirm({
  open,
  noun,
  confirmLabel,
  onConfirm,
  onCancel,
  onAddAsNote,
}: {
  open: boolean
  /** What is being gated — "answer" (panel) or "suggestion" (card). */
  noun: 'answer' | 'suggestion'
  /** The destructive proceed action's label, e.g. "Add to composer anyway". */
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
  /** Optional third action: insert as an internal note instead (never
   *  gated). Its presence also extends the safety copy with the note
   *  alternative. */
  onAddAsNote?: () => void
}) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>This {noun} uses internal sources</AlertDialogTitle>
          <AlertDialogDescription>
            It cites content your customers are not meant to see. Review before sending
            {onAddAsNote ? ', or add it as an internal note instead' : ''}.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          {onAddAsNote && (
            <Button type="button" variant="secondary" onClick={onAddAsNote}>
              Add as note
            </Button>
          )}
          <Button
            type="button"
            className={buttonVariants({ variant: 'destructive' })}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
