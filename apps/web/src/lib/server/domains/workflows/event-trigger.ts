/**
 * Event bus -> workflow trigger bridge (support platform §4.6, Slice 5d-iii). Maps
 * a dispatched conversation/message event to a WorkflowTrigger and hands it to the
 * dispatcher. Non-conversation events (posts, comments, tickets, ...) map to null;
 * ticket-scoped triggers are a later extension. dispatchWorkflowsForEvent is fully
 * error-isolated so it can be fire-and-forget from the event pipeline without ever
 * affecting the existing hook delivery.
 */
import type { EventData } from '@/lib/server/events/types'
import type { ConversationId, PrincipalId } from '@quackback/ids'
import type { PrincipalType } from '@/lib/server/policy/types'
import { logger } from '@/lib/server/logger'
import { dispatchWorkflowTrigger, type WorkflowTrigger } from './dispatcher'
import { interruptWaitingRuns } from './workflow.engine'

const log = logger.child({ component: 'workflow-event-trigger' })

/** Map an event to a workflow trigger, or null when it isn't conversation-scoped.
 *  The event's trigger_type is its event type verbatim, so a workflow subscribes
 *  by the same name the bus dispatches. */
export function eventToWorkflowTrigger(event: EventData): WorkflowTrigger | null {
  // An automated (service) actor is carried through; the dispatcher gates it out.
  const actorType: PrincipalType = event.actor?.type === 'service' ? 'service' : 'user'

  switch (event.type) {
    case 'conversation.created': {
      const c = event.data.conversation
      return {
        triggerType: event.type,
        conversationId: c.id as ConversationId,
        actorType,
        subjectPrincipalId: (c.visitorPrincipalId ?? null) as PrincipalId | null,
        message: null,
      }
    }
    case 'conversation.status_changed':
    case 'conversation.assigned':
    case 'conversation.priority_changed':
    case 'conversation.csat_submitted': {
      return {
        triggerType: event.type,
        conversationId: event.data.conversation.id as ConversationId,
        actorType,
        subjectPrincipalId: null,
        message: null,
      }
    }
    case 'message.created':
    case 'message.note_created': {
      const m = event.data.message
      return {
        triggerType: event.type,
        conversationId: m.conversationId as ConversationId,
        actorType,
        // The customer is the frequency-cap subject; a teammate message has none.
        subjectPrincipalId: (m.senderType === 'visitor'
          ? m.authorPrincipalId
          : null) as PrincipalId | null,
        message: { body: m.content, senderType: m.senderType },
      }
    }
    case 'assistant.handed_off': {
      // The assistant's own service principal authors this event, so the
      // dispatcher's automated-actor gate would silently swallow it. That gate
      // exists to stop a workflow's own automated action from re-triggering
      // workflows; a terminal "the assistant gave up, hand off to a human"
      // signal is not that loop (no workflow action can produce it), so the
      // trigger opts out explicitly — actorType stays truthful for any other
      // consumer.
      return {
        triggerType: event.type,
        conversationId: event.data.conversationId as ConversationId,
        actorType,
        allowServiceActor: true,
        subjectPrincipalId: null,
        message: null,
      }
    }
    default:
      return null
  }
}

/** A reply (any message) or a close ends pending waits on the conversation. */
function isInterruptingEvent(event: EventData): boolean {
  return (
    event.type === 'message.created' ||
    (event.type === 'conversation.status_changed' && event.data.newStatus === 'closed')
  )
}

/**
 * Fire workflow triggers for a dispatched event. Safe to call fire-and-forget:
 * it maps + dispatches and swallows every error, so a workflow fault never
 * touches the event pipeline or the request that produced the event.
 *
 * A reply or close first interrupts any pending waits on the conversation — done
 * BEFORE the new dispatch (and sequentially, not on the racy fire-and-forget bus)
 * so a wait-bearing run the customer already answered doesn't fire, while the run
 * this same event triggers is created afterwards and never caught by its own
 * event's interrupt.
 */
export async function dispatchWorkflowsForEvent(event: EventData): Promise<void> {
  try {
    const trigger = eventToWorkflowTrigger(event)
    if (!trigger) return
    if (isInterruptingEvent(event)) await interruptWaitingRuns(trigger.conversationId)
    await dispatchWorkflowTrigger(trigger)
  } catch (err) {
    log.error({ err, eventType: event.type }, 'workflow dispatch failed')
  }
}
