/**
 * Query options for the Approvals page. `waiting`, the rail's count and
 * Home's list, lives in approval-waiting because every admin page loads it;
 * its count is the Waiting tab's too. The lists page through every request.
 */
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import { getApprovalFn, listApprovalsFn } from '@/lib/server/functions/approvals'
import { approvalWaitingKey, approvalWaitingQuery } from './approval-waiting'

export type ApprovalsView = 'waiting' | 'decided'

export const approvalKeys = {
  all: ['approvals'] as const,
  waiting: approvalWaitingKey,
  list: (view: ApprovalsView) => ['approvals', 'list', view] as const,
  detail: (id: string) => ['approvals', 'detail', id] as const,
}

export const approvalQueries = {
  waiting: approvalWaitingQuery,
  list: (view: ApprovalsView) =>
    infiniteQueryOptions({
      queryKey: approvalKeys.list(view),
      queryFn: ({ pageParam }) => listApprovalsFn({ data: { view, cursor: pageParam } }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
  detail: (id: string) =>
    queryOptions({
      queryKey: approvalKeys.detail(id),
      queryFn: () => getApprovalFn({ data: { approvalId: id } }),
    }),
}
