/**
 * Apply a macro's bundled actions to the conversation it was used in, by
 * delegating to the existing conversation services (assign / tag / priority /
 * snooze / close). Each action is applied best-effort and independently; a
 * failure is logged and skipped so one bad action never blocks the reply.
 *
 * Deferred shape: `set_attribute` needs a general conversation custom-attribute
 * setter that does not exist yet (conversation.set_attributes is a reserved
 * permission). It is accepted and stored but no-ops here until that lands.
 */
import type { ConversationId, PrincipalId, ConversationTagId, TeamId } from '@quackback/ids'
import type { MacroAction, MacroSnoozePreset } from '@/lib/server/db'
import type { Actor } from '@/lib/server/policy/types'
import { tomorrowAt } from '@/lib/shared/utils/date'
import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'macro-actions' })

/** Resolve a snooze preset to a wake time; `until_reply` defers with no timer. */
function snoozeUntil(preset: MacroSnoozePreset): Date | null {
  switch (preset) {
    case 'tomorrow':
      return tomorrowAt(9)
    case 'next_week': {
      const d = tomorrowAt(9)
      d.setDate(d.getDate() + 6)
      return d
    }
    case 'until_reply':
    default:
      return null
  }
}

/**
 * Run each action against the conversation. Returns the labels of the actions
 * that were actually applied (deferred/failed ones are excluded), so the caller
 * can tell the agent exactly what happened.
 */
export async function applyMacroActions(
  conversationId: ConversationId,
  actions: MacroAction[],
  actor: Actor
): Promise<string[]> {
  if (actions.length === 0) return []
  const service = await import('@/lib/server/domains/conversation/conversation.service')
  const tags = await import('@/lib/server/domains/conversation/conversation-tag.service')
  const applied: string[] = []
  for (const action of actions) {
    try {
      switch (action.type) {
        case 'assign_agent':
          await service.assignConversation(conversationId, action.principalId as PrincipalId, actor)
          applied.push('assigned')
          break
        case 'assign_team':
          await service.assignTeam(conversationId, action.teamId as TeamId, actor)
          applied.push('assigned to team')
          break
        case 'add_tag':
          await tags.attachTag(conversationId, action.tagId as ConversationTagId)
          applied.push('tagged')
          break
        case 'set_priority':
          await service.setConversationPriority(conversationId, action.priority, actor)
          applied.push(`priority ${action.priority}`)
          break
        case 'snooze':
          await service.snoozeConversation(conversationId, snoozeUntil(action.preset), actor)
          applied.push('snoozed')
          break
        case 'close':
          await service.setConversationStatus(conversationId, 'closed', actor)
          applied.push('closed')
          break
        case 'set_attribute':
          // Deferred: no general conversation custom-attribute setter yet.
          break
      }
    } catch (err) {
      log.error({ err, action: action.type, conversationId }, 'macro action failed')
    }
  }
  return applied
}
