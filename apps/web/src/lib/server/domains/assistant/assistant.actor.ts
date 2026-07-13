/**
 * Reader-biased authority for Quinn. Autonomous turns can inspect and reply to
 * conversations, and publish team-only pending-action notices, but cannot
 * mutate workflow state or publish on a customer's behalf. Approved actions
 * execute under the approving teammate's actor.
 *
 * The explicit ceiling cannot silently widen as the admin role grows.
 */
import type { Actor } from '@/lib/server/policy/types'
import { boundedServiceActor } from '@/lib/server/policy/service-actor'
import type { PrincipalId } from '@quackback/ids'
import { PERMISSIONS, type PermissionKey } from '@/lib/shared/permissions'

/**
 * The bounded authority Quinn acts with autonomously.
 */
export const ASSISTANT_PERMISSIONS: ReadonlySet<PermissionKey> = new Set([
  PERMISSIONS.CONVERSATION_VIEW,
  PERMISSIONS.CONVERSATION_VIEW_ALL,
  PERMISSIONS.CONVERSATION_REPLY,
  // Pending-action proposal and expiry notices are fixed, team-only messages;
  // no model-facing tool exposes arbitrary ticket-note writes.
  PERMISSIONS.TICKET_NOTE,
])

export function quinnActor(principalId: PrincipalId): Actor {
  return boundedServiceActor(ASSISTANT_PERMISSIONS, principalId)
}
