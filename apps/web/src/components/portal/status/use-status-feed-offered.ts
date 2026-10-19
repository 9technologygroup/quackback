import { useWorkspaceSettings } from '@/lib/client/hooks/use-root-context'
import { isStatusFeedReadable } from '@/lib/shared/status-settings'

/**
 * Whether the status page offers its RSS feed: only where a feed reader,
 * which has no session, is served it (`isStatusFeedReadable`). A signed-in
 * visitor inside a private portal, or on a page for signed-in visitors or
 * chosen segments, would otherwise be pointed at a feed that is empty.
 */
export function useStatusFeedOffered(): boolean {
  return isStatusFeedReadable(useWorkspaceSettings())
}
