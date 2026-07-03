import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronDownIcon } from '@heroicons/react/24/solid'
import { toast } from 'sonner'
import type { ConversationId } from '@quackback/ids'
import type { ConversationStatus } from '@/lib/shared/conversation/types'
import { setConversationStatusFn, snoozeConversationFn } from '@/lib/server/functions/conversation'
import { tomorrowAt, inHours, nextMondayAt } from '@/lib/shared/utils'
import { DateTimePicker } from '@/components/ui/datetime-picker'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/** Compact label for a snooze wake time, in the agent's local (workspace) time. */
const wakeFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

/**
 * The conversation status control. Open and Closed set the status directly;
 * Snooze defers the thread with presets (later today, tomorrow, next week, or
 * until the customer replies) or a specific wake time, and picking Open again
 * wakes a snoozed thread. When snoozed until a time, the badge shows it. Used in
 * the detail panel and the thread header, so the full lifecycle is settable at
 * every width.
 */
export function StatusControl({
  conversationId,
  status,
  snoozedUntil,
  onChanged,
}: {
  conversationId: ConversationId
  status: ConversationStatus
  /** Wake time (ISO) when snoozed until a specific instant; null otherwise. */
  snoozedUntil?: string | null
  onChanged: () => void
}) {
  const queryClient = useQueryClient()
  const [customOpen, setCustomOpen] = useState(false)
  const [customDate, setCustomDate] = useState<Date | undefined>(() => tomorrowAt(9))
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'inbox', 'thread', conversationId] })
    onChanged()
  }
  const statusMut = useMutation({
    mutationFn: (next: ConversationStatus) =>
      setConversationStatusFn({ data: { conversationId, status: next } }),
    onSuccess: invalidate,
    onError: () => toast.error('Failed to update status'),
  })
  const snoozeMut = useMutation({
    mutationFn: (until: string | null) => snoozeConversationFn({ data: { conversationId, until } }),
    onSuccess: invalidate,
    onError: () => toast.error('Failed to snooze conversation'),
  })
  const busy = statusMut.isPending || snoozeMut.isPending

  const snooze = (until: string | null) => snoozeMut.mutate(until)
  const wakeLabel =
    status === 'snoozed' && snoozedUntil ? wakeFormatter.format(new Date(snoozedUntil)) : null

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={busy}
            title={wakeLabel ? `Snoozed until ${wakeLabel}` : undefined}
            className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
          >
            <span className="capitalize">{status}</span>
            {wakeLabel && <span className="text-muted-foreground">· {wakeLabel}</span>}
            <ChevronDownIcon className="h-3 w-3 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {/* Open doubles as "unsnooze" — it clears any snooze timer. */}
          <DropdownMenuItem onClick={() => statusMut.mutate('open')} className="text-xs capitalize">
            open
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
            Snooze
          </DropdownMenuLabel>
          <DropdownMenuItem onClick={() => snooze(inHours(4).toISOString())} className="text-xs">
            Later today
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => snooze(tomorrowAt(9).toISOString())} className="text-xs">
            Tomorrow
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => snooze(nextMondayAt(9).toISOString())}
            className="text-xs"
          >
            Next week
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => snooze(null)} className="text-xs">
            Until they reply
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setCustomDate(tomorrowAt(9))
              // Let the menu finish closing before the dialog grabs focus, so
              // the two Radix overlays don't fight over it.
              requestAnimationFrame(() => setCustomOpen(true))
            }}
            className="text-xs"
          >
            Pick a date &amp; time…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => statusMut.mutate('closed')}
            className="text-xs capitalize"
          >
            closed
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={customOpen} onOpenChange={setCustomOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Snooze until</DialogTitle>
            <DialogDescription>
              The conversation leaves your open queue and returns at the time you pick.
            </DialogDescription>
          </DialogHeader>
          <DateTimePicker
            value={customDate}
            onChange={setCustomDate}
            minDate={new Date()}
            className="w-full"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCustomOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!customDate || busy}
              onClick={() => {
                if (!customDate) return
                snooze(customDate.toISOString())
                setCustomOpen(false)
              }}
            >
              Snooze
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
