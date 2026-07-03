import { useQuery } from '@tanstack/react-query'
import { ArrowLeftIcon } from '@heroicons/react/24/solid'
import { ChatBubbleLeftRightIcon } from '@heroicons/react/24/outline'
import type { TicketId } from '@quackback/ids'
import { ticketQueries } from '@/lib/client/queries/tickets'
import { TicketTypeBadge, TicketStageChip } from '@/components/admin/tickets/ticket-chips'
import { TicketStatusControl } from '@/components/admin/tickets/ticket-controls'
import { TicketDetailPanel } from '@/components/admin/tickets/ticket-detail-panel'
import { EmptyState } from '@/components/shared/empty-state'
import { Spinner } from '@/components/shared/spinner'

/**
 * The ticket detail: a center panel with the ticket header (title, reference,
 * type, status) and a quiet empty-state, plus the right PROPERTIES panel.
 *
 * 7A is properties-only. The message thread + composer arrive with ticket
 * messaging (7B), so the center deliberately shows no reply surface.
 */
export function TicketDetail({
  ticketId,
  onBack,
  onChanged,
}: {
  ticketId: TicketId
  onBack: () => void
  onChanged: () => void
}) {
  const { data: ticket, isLoading } = useQuery(ticketQueries.detail(ticketId))

  if (isLoading) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center">
        <Spinner />
      </div>
    )
  }
  if (!ticket) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center">
        <EmptyState
          icon={ChatBubbleLeftRightIcon}
          title="Ticket not found"
          description="It may have been deleted or you no longer have access."
        />
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <div className="flex items-start gap-3 border-b border-border/50 px-4 py-3">
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to tickets"
            className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:hidden"
          >
            <ArrowLeftIcon className="size-4" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground">{ticket.reference}</span>
              <TicketTypeBadge type={ticket.type} />
            </div>
            <h1 className="mt-1 truncate text-base font-semibold leading-tight">{ticket.title}</h1>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <TicketStatusControl ticket={ticket} onChanged={onChanged} />
            <TicketStageChip stage={ticket.stage} />
          </div>
        </div>

        {/* Center: no thread in 7A */}
        <div className="flex flex-1 items-center justify-center p-6">
          <EmptyState
            icon={ChatBubbleLeftRightIcon}
            title="Ticket messaging coming soon"
            description="Replies and the full thread arrive with ticket messaging. For now this ticket tracks its properties and status."
          />
        </div>
      </div>

      <TicketDetailPanel ticket={ticket} onChanged={onChanged} />
    </div>
  )
}
