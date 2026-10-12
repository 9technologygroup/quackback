import type { AssistantAgentKind } from './assistant/config'
import { PERMISSIONS, type PermissionKey } from './permissions'

/**
 * The two AI permissions. The customer-facing AI answers customers; the
 * teammate AI serves the team (Home chat, inbox assist, Slack). Shared AI
 * settings (the skills and connectors libraries, knowledge sources, guidance
 * and tool lists) open to a holder of either.
 */
export const AI_ANY_PERMISSIONS: readonly PermissionKey[] = [
  PERMISSIONS.AI_CUSTOMER_MANAGE,
  PERMISSIONS.AI_TEAMMATE_MANAGE,
]

/** The permission that governs an agent: only `agent` answers customers; Copilot and the Home chat serve teammates. */
export function aiPermissionForAgent(agent: AssistantAgentKind): PermissionKey {
  return agent === 'agent' ? PERMISSIONS.AI_CUSTOMER_MANAGE : PERMISSIONS.AI_TEAMMATE_MANAGE
}

/** Whether a permission set holds at least one AI management permission. */
export function holdsAnyAiPermission(held: ReadonlySet<PermissionKey>): boolean {
  return AI_ANY_PERMISSIONS.some((key) => held.has(key))
}

/**
 * The permissions needed to assign something to the given agents: handing a
 * skill or connector to the customer AI takes the customer permission, handing
 * it to the teammate AI takes the teammate permission.
 */
export function aiPermissionsForAssignments(
  assignments: { agent?: boolean; copilot?: boolean } | undefined
): PermissionKey[] {
  const needed: PermissionKey[] = []
  if (assignments?.agent) needed.push(PERMISSIONS.AI_CUSTOMER_MANAGE)
  if (assignments?.copilot) needed.push(PERMISSIONS.AI_TEAMMATE_MANAGE)
  return needed
}
