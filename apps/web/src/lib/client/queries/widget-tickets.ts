/**
 * Query-options factory for the widget Tickets surface (widget ticket
 * submission). Mirrors the portal `portal-tickets.ts` factory but forwards the
 * widget Bearer token (`getWidgetAuthHeaders()`) on every call — token-authed
 * visitors otherwise fail the server-side auth guard — and keys on
 * `sessionVersion` so the lists refetch after identify merges the visitor's
 * anonymous history onto their account (the `widget-messages.tsx` pattern).
 * `retry: false` so an anonymous visitor's `EMAIL_REQUIRED` surfaces at once as
 * the choice state instead of after three retries.
 */
import { queryOptions } from '@tanstack/react-query'
import type { TicketId } from '@quackback/ids'
import {
  getWidgetTicketFormFn,
  listMyWidgetTicketsFn,
  getMyWidgetTicketFn,
  getMyWidgetTicketThreadFn,
  getMyWidgetTicketStageLabelsFn,
} from '@/lib/server/functions/widget-tickets'
import { getWidgetAuthHeaders } from '@/lib/client/widget-auth'

export const widgetTicketKeys = {
  all: () => ['widget', 'tickets'] as const,
  list: (sessionVersion: number) => [...widgetTicketKeys.all(), 'list', sessionVersion] as const,
  detail: (sessionVersion: number, id: TicketId) =>
    [...widgetTicketKeys.all(), 'detail', sessionVersion, id] as const,
  thread: (sessionVersion: number, id: TicketId) =>
    [...widgetTicketKeys.all(), 'thread', sessionVersion, id] as const,
  form: (sessionVersion: number) => [...widgetTicketKeys.all(), 'form', sessionVersion] as const,
  stageLabels: (sessionVersion: number) =>
    [...widgetTicketKeys.all(), 'stage-labels', sessionVersion] as const,
}

export const widgetTicketQueries = {
  /** The customer intake form shape (visibleToCustomer fields) the New-Ticket form renders. */
  form: (sessionVersion: number) =>
    queryOptions({
      queryKey: widgetTicketKeys.form(sessionVersion),
      queryFn: () => getWidgetTicketFormFn({ headers: getWidgetAuthHeaders() }),
      staleTime: 60_000,
      retry: false,
    }),

  /** The visitor's own tickets, newest activity first. */
  list: (sessionVersion: number) =>
    queryOptions({
      queryKey: widgetTicketKeys.list(sessionVersion),
      queryFn: () => listMyWidgetTicketsFn({ headers: getWidgetAuthHeaders() }),
      staleTime: 30_000,
      retry: false,
    }),

  /** One of the visitor's tickets (header + status + stage). */
  detail: (sessionVersion: number, id: TicketId) =>
    queryOptions({
      queryKey: widgetTicketKeys.detail(sessionVersion, id),
      queryFn: () =>
        getMyWidgetTicketFn({ data: { ticketId: id }, headers: getWidgetAuthHeaders() }),
      staleTime: 30_000,
      retry: false,
    }),

  /** The customer-visible thread of one of the visitor's tickets. */
  thread: (sessionVersion: number, id: TicketId) =>
    queryOptions({
      queryKey: widgetTicketKeys.thread(sessionVersion, id),
      queryFn: () =>
        getMyWidgetTicketThreadFn({ data: { ticketId: id }, headers: getWidgetAuthHeaders() }),
      staleTime: 10_000,
      retry: false,
    }),

  /** The workspace's stage labels for the StageTracker (B19). Edited rarely
   *  (ticket settings), so a long stale window is fine. */
  stageLabels: (sessionVersion: number) =>
    queryOptions({
      queryKey: widgetTicketKeys.stageLabels(sessionVersion),
      queryFn: () => getMyWidgetTicketStageLabelsFn({ headers: getWidgetAuthHeaders() }),
      staleTime: 300_000,
      retry: false,
    }),
}
