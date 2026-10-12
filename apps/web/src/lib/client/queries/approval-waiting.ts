/**
 * What waits on the viewer, for the rail's count and Home's list.
 *
 * Apart from the Approvals page's queries because the admin layout reads it on
 * every page: this file is all of Approvals that every admin page loads.
 * The layout warms it with the document, so neither the rail nor Home asks
 * again as the viewer moves between pages. A decision refreshes it, and so
 * does a new approval notification (see useRefreshWaitingOnNewApproval); it has no poll
 * of its own.
 */
import { queryOptions } from '@tanstack/react-query'
import { getRailCountsFn } from '@/lib/server/functions/approval-counts'

export const approvalWaitingKey = () => ['approvals', 'waiting'] as const

/** How many requests wait on the viewer, and the newest few. */
export const approvalWaitingQuery = () =>
  queryOptions({
    queryKey: approvalWaitingKey(),
    queryFn: async () => (await getRailCountsFn()).waiting,
    staleTime: 30 * 1000,
  })
