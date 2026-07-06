/**
 * Query-options factory for the unified inbox endpoint (UNIFIED-INBOX-SPEC.md
 * §3.1): the merged conversation+ticket list (`listInboxItemsFn`) and its
 * nav-badge counts (`fetchInboxCountsFn`). Only the scopes `usesUnifiedInboxList`
 * (inbox-scope.ts) recognizes call `itemList` — everything else keeps reading
 * `conversationInboxQueries.conversationList` from conversation-inbox.ts, which
 * this module does not touch.
 */
import { queryOptions } from '@tanstack/react-query'
import type { TicketId } from '@quackback/ids'
import { listInboxItemsFn, fetchInboxCountsFn } from '@/lib/server/functions/inbox'
import { listTicketMessagesFn, getTicketFn } from '@/lib/server/functions/tickets'
import { ticketKeys } from '@/lib/client/queries/tickets'
import { asAgentMessage } from '@/lib/shared/conversation/types'
import type { InboxListParams } from '@/lib/client/conversation/inbox-scope'

export const inboxKeys = {
  /** Prefix of every unified-inbox query (broad invalidation target). */
  all: () => ['admin', 'inbox', 'unified'] as const,
  /** Prefix of every unified item-list query (all scopes/filters). */
  items: () => [...inboxKeys.all(), 'items'] as const,
  /** One item-list page for a specific filter. */
  item: (filterKey: string) => [...inboxKeys.items(), filterKey] as const,
  /** The nav-badge counts (mine/unassigned/tickets-by-type). */
  counts: () => [...inboxKeys.all(), 'counts'] as const,
}

/** A deterministic string key for a list filter (mirrors `ticketListKey`). */
function inboxListParamsKey(params: InboxListParams): string {
  return [
    params.facet,
    (params.kinds ?? []).join(','),
    params.ticketType ?? '',
    params.priority ?? '',
    params.search ?? '',
    params.assignee ?? '',
    params.teamId ?? '',
    params.companyId ?? '',
    params.sort ?? '',
  ].join('|')
}

export const inboxQueries = {
  /** The unified conversation+ticket list for a scope + facet/priority/search
   *  refinement. No cursor/pagination wiring yet — mirrors the conversation
   *  inbox's current first-page-only behavior (see the M2 report). */
  itemList: (params: InboxListParams) =>
    queryOptions({
      queryKey: inboxKeys.item(inboxListParamsKey(params)),
      queryFn: () => listInboxItemsFn({ data: params }),
    }),

  /** Nav-badge counts (mine/unassigned/tickets-by-type). */
  counts: () =>
    queryOptions({
      queryKey: inboxKeys.counts(),
      queryFn: () => fetchInboxCountsFn(),
      staleTime: 60_000,
    }),

  // -------------------------------------------------------------------------
  // Ticket thread/detail (§2.5, M4): the unified thread's ticket-kind data.
  // Deliberately keyed under `ticketKeys` (not a new `inboxKeys` namespace) —
  // `lib/client/queries/tickets.ts` is only deleted in M6, and the inbox
  // route's `refreshInbox` already invalidates `ticketKeys.all()` to refresh
  // the (to-be-deleted) ticket-only surfaces; reusing the same keys means
  // that one invalidation keeps covering the unified thread too, with no
  // second cache entry to keep in sync.
  // -------------------------------------------------------------------------

  /** A ticket's message thread (oldest-first), coerced through `asAgentMessage`
   *  so the cache always holds `AgentConversationMessageDTO` regardless of
   *  whether the server response already carries reactions/flags — mirrors
   *  `ticketQueries.thread` (same key, so a `ticketKeys.all()` invalidation
   *  covers both). */
  ticketThread: (id: TicketId) =>
    queryOptions({
      queryKey: ticketKeys.thread(id),
      queryFn: async () => {
        const page = await listTicketMessagesFn({ data: { ticketId: id } })
        return { ...page, messages: page.messages.map(asAgentMessage) }
      },
      staleTime: 10_000,
    }),

  /** A single ticket's properties, for the unified thread's header controls
   *  (status/assignee/priority/type/stage) and the route's interim
   *  `TicketDetailPanel` slot — same key as `ticketQueries.detail` so both
   *  readers share one cache entry. */
  ticketDetail: (id: TicketId) =>
    queryOptions({
      queryKey: ticketKeys.detail(id),
      queryFn: () => getTicketFn({ data: { ticketId: id } }),
      staleTime: 60_000,
    }),
}
