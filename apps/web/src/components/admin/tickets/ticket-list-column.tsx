import { ChevronDownIcon, BarsArrowDownIcon, PlusIcon } from '@heroicons/react/24/solid'
import type { TicketId } from '@quackback/ids'
import type { TicketDTO, TicketSort } from '@/lib/server/domains/tickets'
import type { TicketType, TicketStatusCategory } from '@/lib/shared/db-types'
import { TICKET_TYPES, TICKET_STATUS_CATEGORIES } from '@/lib/shared/db-types'
import { TICKET_STATUS_CATEGORY_LABELS } from '@/lib/shared/tickets'
import { PriorityDot } from '@/components/admin/conversation/priority-control'
import {
  TicketTypeBadge,
  TicketStatusChip,
  TicketStageChip,
  ticketTypeLabel,
} from '@/components/admin/tickets/ticket-chips'
import { Avatar } from '@/components/ui/avatar'
import { Spinner } from '@/components/shared/spinner'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/shared/utils'

/** The assignee scope the list is filtered to. */
export type TicketScope = 'all' | 'mine' | 'unassigned'

const SCOPES: { value: TicketScope; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'mine', label: 'Mine' },
  { value: 'unassigned', label: 'Unassigned' },
]

const SORT_LABELS: Record<TicketSort, string> = {
  recent: 'Recent',
  oldest: 'Oldest',
  created: 'Created',
  priority: 'Priority',
}
const SORTS = Object.keys(SORT_LABELS) as TicketSort[]

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/** The assignee glyph for a row: teammate avatar, team initial, or a faint icon. */
function AssigneeGlyph({ assignee }: { assignee: TicketDTO['assignee'] }) {
  if (assignee.principalId) {
    return (
      <Avatar
        src={undefined}
        name={assignee.displayName ?? 'Agent'}
        className="size-6 shrink-0 text-[9px]"
      />
    )
  }
  if (assignee.teamId) {
    return (
      <span
        title={assignee.teamName ?? 'Team'}
        className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground"
      >
        {(assignee.teamName ?? 'T').charAt(0).toUpperCase()}
      </span>
    )
  }
  return <span className="size-6 shrink-0" aria-hidden="true" />
}

export interface TicketListColumnProps {
  scope: TicketScope
  onScope: (scope: TicketScope) => void
  typeFilter?: TicketType
  onTypeFilter: (type?: TicketType) => void
  statusCategory?: TicketStatusCategory
  onStatusCategory: (category?: TicketStatusCategory) => void
  sort: TicketSort
  onSort: (sort: TicketSort) => void
  loading: boolean
  tickets: TicketDTO[]
  selectedId: TicketId | null
  onSelect: (id: TicketId) => void
  onNewTicket: () => void
}

/**
 * The middle column of the ticket workspace: a scope segmented control, the type
 * / status / sort refinements, and the ticket rows. Purely presentational — all
 * state lives in the route.
 */
export function TicketListColumn({
  scope,
  onScope,
  typeFilter,
  onTypeFilter,
  statusCategory,
  onStatusCategory,
  sort,
  onSort,
  loading,
  tickets,
  selectedId,
  onSelect,
  onNewTicket,
}: TicketListColumnProps) {
  return (
    <div
      className={cn(
        'flex min-h-0 w-full shrink-0 flex-col border-r border-border/50 md:w-96',
        selectedId && 'hidden md:flex'
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/50 px-4 py-[0.85rem]">
        <h2 className="min-w-0 truncate text-sm font-semibold leading-tight">Tickets</h2>
        <button
          type="button"
          onClick={onNewTicket}
          title="New ticket"
          aria-label="New ticket"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <PlusIcon className="size-4" />
        </button>
      </div>

      {/* Scope: All / Mine / Unassigned */}
      <div className="flex flex-wrap gap-1.5 px-3 pb-1 pt-2">
        {SCOPES.map((s) => {
          const active = scope === s.value
          return (
            <button
              key={s.value}
              type="button"
              onClick={() => onScope(s.value)}
              className={cn(
                'rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
                active
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              {s.label}
            </button>
          )
        })}
      </div>

      {/* Type / status / sort refinements */}
      <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none px-3 py-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Filter by type"
              className={cn(
                'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-xs font-medium transition-colors',
                typeFilter ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted'
              )}
            >
              {typeFilter ? ticketTypeLabel(typeFilter) : 'Type'}
              <ChevronDownIcon className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => onTypeFilter(undefined)} className="text-xs">
              All types
            </DropdownMenuItem>
            {TICKET_TYPES.map((t) => (
              <DropdownMenuItem key={t} onClick={() => onTypeFilter(t)} className="text-xs">
                {ticketTypeLabel(t)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Filter by status"
              className={cn(
                'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-xs font-medium transition-colors',
                statusCategory
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted'
              )}
            >
              {statusCategory ? TICKET_STATUS_CATEGORY_LABELS[statusCategory] : 'Status'}
              <ChevronDownIcon className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => onStatusCategory(undefined)} className="text-xs">
              All statuses
            </DropdownMenuItem>
            {TICKET_STATUS_CATEGORIES.map((c) => (
              <DropdownMenuItem key={c} onClick={() => onStatusCategory(c)} className="text-xs">
                {TICKET_STATUS_CATEGORY_LABELS[c]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Sort tickets"
              className={cn(
                'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-xs font-medium transition-colors',
                sort !== 'recent'
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted'
              )}
            >
              <BarsArrowDownIcon className="h-3.5 w-3.5" />
              {SORT_LABELS[sort]}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {SORTS.map((s) => (
              <DropdownMenuItem
                key={s}
                onClick={() => onSort(s)}
                className={cn('text-xs', s === sort && 'text-primary')}
              >
                {SORT_LABELS[s]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : tickets.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">No tickets</div>
        ) : (
          tickets.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onSelect(t.id)}
              className={cn(
                'flex w-full flex-col gap-1 border-b border-border/30 px-4 py-3 text-left transition-colors',
                selectedId === t.id ? 'bg-muted/60' : 'hover:bg-muted/30'
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <PriorityDot priority={t.priority} />
                  <span className="font-mono text-xs text-muted-foreground">{t.reference}</span>
                  <TicketTypeBadge type={t.type} />
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {relativeTime(t.updatedAt)}
                </span>
              </div>
              <p className="truncate text-sm font-medium">{t.title}</p>
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1">
                  <TicketStatusChip status={t.status} />
                  <TicketStageChip stage={t.stage} />
                </span>
                <AssigneeGlyph assignee={t.assignee} />
              </div>
            </button>
          ))
        )}
      </ScrollArea>
    </div>
  )
}
