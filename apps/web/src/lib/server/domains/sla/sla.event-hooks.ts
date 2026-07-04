/**
 * SLA breach clocks, driven off the event bus (support platform §4.6). The lazy
 * breach evaluator only needs to fire on two human events: the first teammate
 * reply settles the first-response clock, and a close settles the time-to-close
 * clock. Both recorders are idempotent and no-op without an applied SLA, so this
 * can react to every matching event unconditionally.
 *
 * recordSlaFromEvent is safe to call fire-and-forget: it swallows every error, so
 * a breach-recording fault never touches the event pipeline. Unlike the
 * conversation mutations, the recorders are pure DB writes (no realtime/events),
 * so nothing re-enters the bus.
 */
import type { EventData } from '@/lib/server/events/types'
import type { ConversationId } from '@quackback/ids'
import { logger } from '@/lib/server/logger'
import { recordFirstResponse, recordResolution } from './sla.service'

const log = logger.child({ component: 'sla-event-hooks' })

export async function recordSlaFromEvent(event: EventData): Promise<void> {
  try {
    switch (event.type) {
      case 'message.created':
        // Only a teammate reply settles first response; a visitor message doesn't.
        if (event.data.message.senderType === 'agent') {
          await recordFirstResponse(
            event.data.message.conversationId as ConversationId,
            new Date(event.timestamp)
          )
        }
        break
      case 'conversation.status_changed':
        if (event.data.newStatus === 'closed') {
          await recordResolution(
            event.data.conversation.id as ConversationId,
            new Date(event.timestamp)
          )
        }
        break
      default:
        break
    }
  } catch (err) {
    log.error({ err, eventType: event.type }, 'SLA event recording failed')
  }
}
