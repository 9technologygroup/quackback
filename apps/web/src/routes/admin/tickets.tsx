import { createFileRoute, Navigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'
import { TicketIcon } from '@heroicons/react/24/outline'
import { isValidTypeId } from '@quackback/ids'
import type { TicketId } from '@quackback/ids'
import type { TicketListFilter, TicketSort } from '@/lib/server/domains/tickets'
import type { TicketType, TicketStatusCategory } from '@/lib/shared/db-types'
import { TICKET_TYPES, TICKET_STATUS_CATEGORIES } from '@/lib/shared/db-types'
import { ticketQueries } from '@/lib/client/queries/tickets'
import { TicketListColumn, type TicketScope } from '@/components/admin/tickets/ticket-list-column'
import { TicketDetail } from '@/components/admin/tickets/ticket-detail'
import { NewTicketDialog } from '@/components/admin/tickets/new-ticket-dialog'
import { EmptyState } from '@/components/shared/empty-state'
import type { FeatureFlags } from '@/lib/shared/types/settings'

const SORTS: TicketSort[] = ['recent', 'oldest', 'created', 'priority']
function isTicketSort(v: unknown): v is TicketSort {
  return typeof v === 'string' && (SORTS as string[]).includes(v)
}

interface TicketsSearch {
  t?: string
  scope?: 'mine' | 'unassigned'
  type?: TicketType
  status?: TicketStatusCategory
  sort?: TicketSort
}

/** Turn the scope pill into the list filter's assignee clause. */
function scopeToAssignee(scope: TicketScope): TicketListFilter['assignee'] {
  if (scope === 'mine') return 'me'
  if (scope === 'unassigned') return 'unassigned'
  return undefined
}

export const Route = createFileRoute('/admin/tickets')({
  // Everything defining the view lives in the URL so a refresh restores the open
  // ticket + filters and links are shareable.
  validateSearch: (search: Record<string, unknown>): TicketsSearch => ({
    t: typeof search.t === 'string' && isValidTypeId(search.t, 'ticket') ? search.t : undefined,
    scope: search.scope === 'mine' || search.scope === 'unassigned' ? search.scope : undefined,
    type: TICKET_TYPES.includes(search.type as TicketType)
      ? (search.type as TicketType)
      : undefined,
    status: TICKET_STATUS_CATEGORIES.includes(search.status as TicketStatusCategory)
      ? (search.status as TicketStatusCategory)
      : undefined,
    sort: isTicketSort(search.sort) ? search.sort : undefined,
  }),
  loaderDeps: ({ search }) => ({
    t: search.t,
    scope: search.scope,
    type: search.type,
    status: search.status,
    sort: search.sort,
  }),
  loader: async ({ deps, context }) => {
    const { requireWorkspaceRole } = await import('@/lib/server/functions/workspace-utils')
    await requireWorkspaceRole({ data: { allowedRoles: ['admin', 'member'] } })
    const flags = context.settings?.featureFlags as FeatureFlags | undefined
    if (!flags?.supportTickets) return {}
    const { queryClient } = context
    const filter: TicketListFilter = {
      type: deps.type,
      statusCategory: deps.status,
      assignee: scopeToAssignee((deps.scope ?? 'all') as TicketScope),
      sort: deps.sort ?? 'recent',
    }
    const warm = (p: Promise<unknown>) => p.catch(() => undefined)
    await Promise.all([
      warm(queryClient.ensureQueryData(ticketQueries.list(filter))),
      warm(queryClient.ensureQueryData(ticketQueries.statuses())),
      deps.t
        ? warm(queryClient.ensureQueryData(ticketQueries.detail(deps.t as TicketId)))
        : undefined,
    ])
    return {}
  },
  component: TicketsRoute,
})

/** Gate the workspace behind the experimental `supportTickets` flag (off by default). */
function TicketsRoute() {
  const { settings } = Route.useRouteContext()
  const flags = settings?.featureFlags as FeatureFlags | undefined
  if (!flags?.supportTickets) {
    return <Navigate to="/admin/feedback" />
  }
  return <TicketsPage />
}

function TicketsPage() {
  const navigate = Route.useNavigate()
  const {
    t: urlT,
    scope: urlScope,
    type: urlType,
    status: urlStatus,
    sort: urlSort,
  } = Route.useSearch()
  const [composeOpen, setComposeOpen] = useState(false)

  const updateSearch = useCallback(
    (partial: Partial<TicketsSearch>) => {
      void navigate({
        to: '/admin/tickets',
        search: (prev) => ({ ...prev, ...partial }),
        replace: true,
      })
    },
    [navigate]
  )

  const scope: TicketScope = urlScope ?? 'all'
  const sort: TicketSort = urlSort ?? 'recent'
  const selectedId = (urlT as TicketId | undefined) ?? null

  const filter = useMemo<TicketListFilter>(
    () => ({
      type: urlType,
      statusCategory: urlStatus,
      assignee: scopeToAssignee(scope),
      sort,
    }),
    [urlType, urlStatus, scope, sort]
  )

  const { data: tickets, isLoading } = useQuery({
    ...ticketQueries.list(filter),
    refetchInterval: 30_000,
  })

  const selectTicket = useCallback(
    (id: TicketId | null) => updateSearch({ t: id ?? undefined }),
    [updateSearch]
  )

  return (
    <div className="flex h-full">
      <TicketListColumn
        scope={scope}
        onScope={(s) => updateSearch({ scope: s === 'all' ? undefined : s, t: undefined })}
        typeFilter={urlType}
        onTypeFilter={(type) => updateSearch({ type, t: undefined })}
        statusCategory={urlStatus}
        onStatusCategory={(status) => updateSearch({ status, t: undefined })}
        sort={sort}
        onSort={(s) => updateSearch({ sort: s === 'recent' ? undefined : s })}
        loading={isLoading}
        tickets={tickets ?? []}
        selectedId={selectedId}
        onSelect={selectTicket}
        onNewTicket={() => setComposeOpen(true)}
      />

      <div className={selectedId ? 'flex min-w-0 flex-1' : 'hidden min-w-0 flex-1 md:flex'}>
        {selectedId ? (
          <TicketDetail
            key={selectedId}
            ticketId={selectedId}
            onBack={() => selectTicket(null)}
            onChanged={() => {}}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <EmptyState
              icon={TicketIcon}
              title="Select a ticket"
              description="Choose a ticket from the list to view its properties and status."
            />
          </div>
        )}
      </div>

      <NewTicketDialog
        open={composeOpen}
        onOpenChange={setComposeOpen}
        onCreated={(id) => selectTicket(id)}
      />
    </div>
  )
}
