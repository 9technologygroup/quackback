import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useSessionContext } from '@/lib/client/hooks/use-root-context'
import { statusKeys } from '@/lib/client/queries/status'

/**
 * Keep the public status reads in step with who is looking. They are
 * viewer-scoped (a service restricted to a segment, and an incident that only
 * touches such services, shows only to that segment), but their cache keys
 * don't name the viewer. So when the session's principal changes, such as a
 * sign-in in the dialog or a sign-out, the page would keep showing what the
 * previous viewer could see until a reload.
 *
 * On a change, the reads on screen refetch in place, and the rest are
 * dropped, since a route loader reads them back through `ensureQueryData`
 * without refetching.
 */
export function useRefreshStatusForViewer(): void {
  const queryClient = useQueryClient()
  const session = useSessionContext()
  const viewer = session?.user ? `${session.user.id}:${session.user.principalType}` : null
  const lastViewer = useRef(viewer)

  useEffect(() => {
    if (lastViewer.current === viewer) return
    lastViewer.current = viewer
    queryClient.removeQueries({ queryKey: statusKeys.public(), type: 'inactive' })
    void queryClient.invalidateQueries({ queryKey: statusKeys.public() })
  }, [queryClient, viewer])
}
