/**
 * What waits on the viewer, for the rail and Home, with the rail's unread bell
 * count. Kept apart from the rest of the approvals functions because the admin
 * layout holds this on every page, so what it pulls in is what every admin page
 * loads.
 */
import { createServerFn } from '@tanstack/react-start'
import { requireAuth, policyActorFromAuth } from './auth-helpers'

/**
 * The unread bell count and the waiting summary (the count and newest few),
 * from one read (see railCountsFor). The admin document warms it; a refresh
 * reads it again.
 */
export const getRailCountsFn = createServerFn({ method: 'GET' }).handler(async () => {
  const auth = await requireAuth()
  const { railCountsFor } = await import('@/lib/server/domains/assistant/approvals.queue')
  // The actor costs a read of its own, so it is built only once a request is open.
  return railCountsFor(auth.principal.id, () => policyActorFromAuth(auth))
})
