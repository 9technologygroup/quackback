/**
 * Notification sink resolver (EVENTING-V2 WO-8c) — the per-user fan-out:
 * subscriber email + in-app, @-mentions, changelog subscribers, and status-page
 * subscribers, each with their own audience gating and the notification
 * preference matrix.
 *
 * This is the trickiest sink, so the transitional implementation DELEGATES to
 * the already-tested builders in targets.ts (via the reconstructed EventData +
 * hook context) rather than re-porting ~700 lines and risking a parity gap. The
 * WO-15 shadow-diff validates equivalence; Phase 5 folds the builders in and
 * deletes targets.ts. See to-legacy-event.ts for the actor-fidelity caveat.
 */
import { buildHookContext } from '../hook-context'
import { toLegacyEvent } from '../to-legacy-event'
import {
  SUBSCRIBER_EVENT_TYPES,
  MENTION_EVENT_TYPES,
  getSubscriberTargets,
  getMentionTargets,
  getChangelogSubscriberTargets,
  getStatusSubscriberTargets,
  getConversationAssignedTargets,
  getTicketAssignedTargets,
  getAssistantHandedOffTargets,
  getConversationNoteMentionedTargets,
  getTicketStatusChangedTargets,
  getMessageCreatedTargets,
} from '../targets'
import { logger } from '@/lib/server/logger'
import type { SinkResolver } from './registry'
import type { DomainEvent } from '../envelope'
import type { HookTarget } from '../hook-types'

const log = logger.child({ component: 'notification-resolver' })

const SUBSCRIBER_SET = new Set<string>(SUBSCRIBER_EVENT_TYPES)
const MENTION_SET = new Set<string>(MENTION_EVENT_TYPES)
/** Status publish events that drive the status-subscription fan-out. */
const STATUS_NOTIFY_SET = new Set<string>([
  'status.incident_created',
  'status.maintenance_scheduled',
])
/** Support-inbox "bell" events, each resolving to at most one notification target.
 *  ticket.status_changed (requester bell) and message.created (new-message team
 *  bell) were relocated onto these events on `next`; they route here too. */
const BELL_SET = new Set<string>([
  'conversation.assigned',
  'ticket.assigned',
  'assistant.handed_off',
  'conversation.note_mentioned',
  'ticket.status_changed',
  'message.created',
])

export const notificationResolver: SinkResolver = {
  sink: 'notification',
  interestedIn(type: string): boolean {
    return (
      SUBSCRIBER_SET.has(type) ||
      MENTION_SET.has(type) ||
      STATUS_NOTIFY_SET.has(type) ||
      BELL_SET.has(type)
    )
  },
  async resolve(event: DomainEvent): Promise<HookTarget[]> {
    try {
      const legacy = toLegacyEvent(event)
      const out: HookTarget[] = []

      // Subscriber/mention/status fan-outs need the hook context; the bells
      // resolve a single recipient from the payload/DB and don't.
      if (
        SUBSCRIBER_SET.has(event.type) ||
        MENTION_SET.has(event.type) ||
        STATUS_NOTIFY_SET.has(event.type)
      ) {
        const context = await buildHookContext()
        if (context) {
          if (SUBSCRIBER_SET.has(event.type)) {
            out.push(
              ...(event.type === 'changelog.published'
                ? await getChangelogSubscriberTargets(legacy, context)
                : await getSubscriberTargets(legacy, context))
            )
          }
          if (MENTION_SET.has(event.type)) {
            out.push(...(await getMentionTargets(legacy, context)))
          }
          if (STATUS_NOTIFY_SET.has(event.type)) {
            out.push(...(await getStatusSubscriberTargets(legacy, context)))
          }
        }
      }

      // Support-inbox bells (conversation/ticket assignment, assistant hand-off,
      // internal-note @-mention). Each returns at most one target or null.
      if (event.type === 'conversation.assigned') {
        const t = await getConversationAssignedTargets(legacy)
        if (t) out.push(t)
      } else if (event.type === 'ticket.assigned') {
        const t = await getTicketAssignedTargets(legacy)
        if (t) out.push(t)
      } else if (event.type === 'assistant.handed_off') {
        const t = await getAssistantHandedOffTargets(legacy)
        if (t) out.push(t)
      } else if (event.type === 'conversation.note_mentioned') {
        const t = getConversationNoteMentionedTargets(legacy)
        if (t) out.push(t)
      } else if (event.type === 'ticket.status_changed') {
        // Requester bell — fires only on a real public_stage crossing.
        const t = await getTicketStatusChangedTargets(legacy)
        if (t) out.push(t)
      } else if (event.type === 'message.created') {
        // New-message team bell — visitor messages only; the anti-spam presence
        // gate runs in the notification hook's worker, not here.
        const t = await getMessageCreatedTargets(legacy)
        if (t) out.push(t)
      }

      return out
    } catch (error) {
      log.error({ err: error, type: event.type }, 'failed to resolve notification targets')
      return []
    }
  },
}
