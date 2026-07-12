/**
 * Transitional bridge (WO-4): write a legacy `EventData` to the durable outbox
 * via `emit()`, instead of the old fire-and-forget resolve+enqueue. Used by
 * `processEvent` when the EVENTING-V2 flag is on. Phase 1 moves emission into
 * each domain service's own transaction and retires this generic bridge.
 *
 * Because the existing dispatchers run AFTER their mutation has committed (no tx
 * in scope), this opens a short transaction solely to write the outbox row —
 * still strictly better than fire-and-forget, since the row + its pg_notify are
 * atomic and the relay guarantees at-least-once delivery.
 */
import { db } from '@/lib/server/db'
import { logger } from '@/lib/server/logger'
import { emit } from './emit'
import { getEventDefinition } from './catalogue'
import type { EventData } from './types'
import type { EventActorType } from './envelope'

const log = logger.child({ component: 'outbox-dispatch' })

/** Map the legacy actor union onto the outbox actor {type,id}. */
function mapActor(actor: EventData['actor']): { type: EventActorType; id?: string } {
  if (actor.type === 'user') {
    return { type: 'user', id: actor.principalId ?? actor.userId }
  }
  return { type: 'service', id: actor.principalId }
}

/**
 * Best-effort subject id for an event, dug from the known `data` shapes. Falls
 * back to the event id so a row is never rejected for a missing entity id (the
 * per-type precision lands with the hardened payloads in WO-5).
 */
export function extractEntityId(event: EventData): string {
  const d = event.data as unknown as Record<string, unknown>
  const pick = (obj: unknown): string | undefined =>
    obj && typeof obj === 'object' && 'id' in (obj as Record<string, unknown>)
      ? String((obj as { id: unknown }).id)
      : undefined

  return (
    pick(d.post) ??
    pick(d.duplicatePost) ??
    pick(d.comment) ??
    pick(d.changelog) ??
    pick(d.conversation) ??
    pick(d.message) ??
    pick(d.ticket) ??
    pick(d.incident) ??
    (typeof d.conversationId === 'string' ? d.conversationId : undefined) ??
    (typeof d.postId === 'string' ? d.postId : undefined) ??
    (typeof d.incidentId === 'string' ? d.incidentId : undefined) ??
    (typeof d.componentId === 'string' ? d.componentId : undefined) ??
    event.id
  )
}

/**
 * Write one legacy event to the outbox. Returns true if written, false if the
 * type has no catalogue entry (defensive — the coverage test makes this
 * impossible for real EVENT_TYPES, but a stray call shouldn't throw).
 */
export async function writeEventToOutbox(event: EventData): Promise<boolean> {
  const def = getEventDefinition(event.type)
  if (!def) {
    log.warn({ type: event.type }, 'no catalogue definition for event; not written to outbox')
    return false
  }
  await db.transaction((tx) =>
    emit(tx, def, {
      payload: event.data as unknown as Record<string, unknown>,
      actor: mapActor(event.actor),
      entityId: extractEntityId(event),
      context: { source: event.actor.service, correlationId: event.id },
    })
  )
  return true
}
