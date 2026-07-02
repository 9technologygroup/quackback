import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronDownIcon } from '@heroicons/react/24/solid'
import { toast } from 'sonner'
import type { ConversationId } from '@quackback/ids'
import type { ConversationStatus } from '@/lib/shared/conversation/types'
import { setConversationStatusFn, snoozeConversationFn } from '@/lib/server/functions/conversation'
import { tomorrowAt } from '@/lib/shared/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/**
 * The conversation status control. Open and Closed set the status directly;
 * Snooze defers the thread (until the customer replies, or until tomorrow
 * morning) and picking Open again wakes a snoozed thread. Used in the detail
 * panel and the thread header, so the full lifecycle is settable at every width.
 */
export function StatusControl({
  conversationId,
  status,
  onChanged,
}: {
  conversationId: ConversationId
  status: ConversationStatus
  onChanged: () => void
}) {
  const queryClient = useQueryClient()
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
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium capitalize text-foreground hover:bg-muted disabled:opacity-50"
        >
          {status}
          <ChevronDownIcon className="h-3 w-3 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {/* Open doubles as "unsnooze" — it clears any snooze timer. */}
        <DropdownMenuItem onClick={() => statusMut.mutate('open')} className="text-xs capitalize">
          open
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => snoozeMut.mutate(null)} className="text-xs">
          Snooze until they reply
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => snoozeMut.mutate(tomorrowAt(9).toISOString())}
          className="text-xs"
        >
          Snooze until tomorrow
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => statusMut.mutate('closed')} className="text-xs capitalize">
          closed
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
