/**
 * Query-options factory for the admin ticket workspace (support platform §4.2):
 * the single source of truth for its query keys + fetchers, shared by the route
 * and the ticket components. Mirrors the conversation-inbox factory so the list
 * key stays stable for mutation invalidation.
 */
import { queryOptions } from '@tanstack/react-query'
import type { TicketId } from '@quackback/ids'
import {
  listTicketsFn,
  getTicketFn,
  listTicketStatusesFn,
  getTicketStageLabelsFn,
  listTicketMessagesFn,
  getTicketLinksFn,
} from '@/lib/server/functions/tickets'
import type { TicketListFilter } from '@/lib/server/domains/tickets'

/** A deterministic string key for a list filter (so the query cache dedupes). */
export function ticketListKey(filter: TicketListFilter): string {
  return [
    filter.type ?? 'all',
    filter.statusCategory ?? 'all',
    filter.stage ?? 'all',
    filter.assignee ?? 'all',
    filter.teamId ?? '',
    filter.requesterPrincipalId ?? '',
    filter.companyId ?? '',
    filter.sort ?? 'recent',
    filter.limit ?? '',
  ].join('|')
}

export const ticketKeys = {
  /** Prefix of every ticket query (broad invalidation target). */
  all: () => ['admin', 'tickets'] as const,
  /** Prefix of every ticket-list query (all scopes/filters). */
  lists: () => [...ticketKeys.all(), 'list'] as const,
  /** One ticket list for a specific filter. */
  list: (filterKey: string) => [...ticketKeys.lists(), filterKey] as const,
  /** A single ticket's detail. */
  detail: (id: TicketId) => [...ticketKeys.all(), 'detail', id] as const,
  /** The workspace's status catalogue (drives the status picker). */
  statuses: () => [...ticketKeys.all(), 'statuses'] as const,
  /** The workspace's customer-facing stage labels. */
  stageLabels: () => [...ticketKeys.all(), 'stage-labels'] as const,
  /** A single ticket's message thread. */
  thread: (id: TicketId) => [...ticketKeys.all(), 'thread', id] as const,
  /** A single ticket's tracker links (the tracker it belongs to, or its linked tickets). */
  links: (id: TicketId) => [...ticketKeys.all(), 'links', id] as const,
}

export const ticketQueries = {
  /** The ticket list for a scope + type/status/sort refinement. `staleTime` keeps
   *  the loader-warmed data from refetching the instant a row mounts. */
  list: (filter: TicketListFilter) =>
    queryOptions({
      queryKey: ticketKeys.list(ticketListKey(filter)),
      queryFn: () => listTicketsFn({ data: filter }),
      staleTime: 60_000,
    }),

  /** A single ticket (properties only in 7A; the thread arrives with 7B). */
  detail: (id: TicketId) =>
    queryOptions({
      queryKey: ticketKeys.detail(id),
      queryFn: () => getTicketFn({ data: { ticketId: id } }),
      staleTime: 60_000,
    }),

  /** The status catalogue, ordered by category then position. */
  statuses: () =>
    queryOptions({
      queryKey: ticketKeys.statuses(),
      queryFn: () => listTicketStatusesFn(),
      staleTime: 60_000,
    }),

  /** The customer-facing stage labels (drives the status picker's stage hints). */
  stageLabels: () =>
    queryOptions({
      queryKey: ticketKeys.stageLabels(),
      queryFn: () => getTicketStageLabelsFn(),
      staleTime: 60_000,
    }),

  /** A ticket's message thread (oldest-first). No live SSE yet, so a short
   *  staleTime + refetch-on-focus keeps it reasonably fresh for the agent. */
  thread: (id: TicketId) =>
    queryOptions({
      queryKey: ticketKeys.thread(id),
      queryFn: () => listTicketMessagesFn({ data: { ticketId: id } }),
      staleTime: 10_000,
    }),

  /** A ticket's tracker links: for a tracker, the customer tickets it tracks;
   *  for a customer ticket, the tracker it belongs to (or null). */
  links: (id: TicketId) =>
    queryOptions({
      queryKey: ticketKeys.links(id),
      queryFn: () => getTicketLinksFn({ data: { ticketId: id } }),
      staleTime: 30_000,
    }),
}
