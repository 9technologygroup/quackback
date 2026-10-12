import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { approvalWaitingKey, approvalWaitingQuery } from '@/lib/client/queries/approval-waiting'
import { unreadCountQuery } from '@/lib/client/hooks/use-notifications-queries'

/** What waits on the viewer, for Home's list: the answer the admin layout warmed. */
export function useWaitingApprovals() {
  return useQuery(approvalWaitingQuery()).data
}

/** How many requests wait on the viewer, for the rail. It renders again only when that moves. */
export function useWaitingApprovalCount() {
  return useQuery({ ...approvalWaitingQuery(), select: (waiting) => waiting.count }).data
}

/**
 * Reads what waits again when a new approval rings the bell: a rise in the
 * unread count. It never polls on its own, and it only watches the cache, so
 * it adds no request to the bell's and renders nothing. Mounted once, with the rail.
 */
export function useRefreshWaitingOnNewApproval() {
  const queryClient = useQueryClient()
  useEffect(() => {
    const unreadKey = unreadCountQuery().queryKey
    let seen = queryClient.getQueryData<number>(unreadKey)
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.query.queryHash !== JSON.stringify(unreadKey)) return
      const unread = event.query.state.data as number | undefined
      if (unread !== undefined && seen !== undefined && unread > seen)
        void queryClient.invalidateQueries({ queryKey: approvalWaitingKey() })
      if (unread !== undefined) seen = unread
    })
  }, [queryClient])
}
