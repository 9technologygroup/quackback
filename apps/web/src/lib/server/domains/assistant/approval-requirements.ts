import type { assistantPendingActions } from '@/lib/server/db'
import type { PermissionKey } from '@/lib/shared/permissions'
import { SETTINGS_PROPOSAL_TOOL } from './approval-policy'
import { isHomeThreadKey } from './workspace-safety'
import { requiredApprovalPermissions } from './approvals.service'

type PendingActionRow = typeof assistantPendingActions.$inferSelect

type RequirementRow = Pick<
  PendingActionRow,
  'id' | 'toolName' | 'args' | 'originRole' | 'workspaceThreadKey'
>

/**
 * What makes one request's requirement the same as another's. A settings
 * request names its own changes. A tool's depends on the role that proposed
 * it (which agent's connectors it resolves against) and on whether it came
 * from a Home thread, another thread, or none.
 */
function requirementKey(row: RequirementRow): string {
  if (row.toolName === SETTINGS_PROPOSAL_TOOL) return JSON.stringify(['settings', row.id])
  const thread = !row.workspaceThreadKey
    ? 'none'
    : isHomeThreadKey(row.workspaceThreadKey)
      ? 'home'
      : 'thread'
  return JSON.stringify([row.toolName, row.originRole, thread])
}

/**
 * The permissions each request needs, looked up once per distinct requirement
 * within one read.
 */
export function approvalRequirements(): (
  row: RequirementRow
) => Promise<ReadonlySet<PermissionKey> | null> {
  const cache = new Map<string, Promise<ReadonlySet<PermissionKey> | null>>()
  return (row) => {
    const key = requirementKey(row)
    let required = cache.get(key)
    if (!required) {
      required = requiredApprovalPermissions(row)
      cache.set(key, required)
    }
    return required
  }
}
