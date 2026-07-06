/**
 * Bounded authority for Quinn (the AI assistant). Write tools run under an
 * explicit permission set rather than inheriting the admin role — the ceiling
 * stays intentional and can't silently widen as admin grows.
 *
 * Mirrors the workflow automation actor (workflow.engine.ts), ensuring Quinn
 * can act on conversations and support (tickets) but nothing outside those
 * domains regardless of role.
 */
import type { Actor } from '@/lib/server/policy/types'
import { boundedServiceActor } from '@/lib/server/policy/service-actor'
import type { PrincipalId } from '@quackback/ids'
import { PERMISSIONS, type PermissionKey } from '@/lib/shared/permissions'

/**
 * The bounded authority Quinn acts with: exactly the conversation and
 * feedback/ticket actions needed, named explicitly rather than inheriting the
 * whole admin role.
 */
export const ASSISTANT_PERMISSIONS: ReadonlySet<PermissionKey> = new Set([
  PERMISSIONS.CONVERSATION_VIEW,
  PERMISSIONS.CONVERSATION_VIEW_ALL,
  PERMISSIONS.CONVERSATION_REPLY,
  PERMISSIONS.CONVERSATION_SET_STATUS,
  PERMISSIONS.CONVERSATION_SET_ATTRIBUTES,
  PERMISSIONS.TICKET_CREATE,
  // Lets Quinn post its own pending-action proposal/expiry notes on a
  // ticket-scoped copilot turn (unified inbox §2.9) — see
  // pending-actions.service.ts's `surfacePendingActionNote` and
  // `sweepAndNotifyExpiredPendingActions`, the only callers that post as
  // Quinn on a ticket thread today.
  PERMISSIONS.TICKET_NOTE,
  PERMISSIONS.POST_CREATE,
  PERMISSIONS.POST_VOTE_ON_BEHALF,
])

export function quinnActor(principalId: PrincipalId): Actor {
  return boundedServiceActor(ASSISTANT_PERMISSIONS, principalId)
}
