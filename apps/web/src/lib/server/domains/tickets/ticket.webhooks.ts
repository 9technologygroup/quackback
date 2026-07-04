/**
 * Ticket → webhook event bridge (support platform §4.2). Maps ticket rows to
 * sanitized event payloads and dispatches them on the shared event bus. Called
 * fire-and-forget from ticket.service after a write commits: a dispatch failure
 * must never break the write (mirrors conversation.webhooks).
 *
 * These are the agent/integration-facing lifecycle signals. The customer-facing
 * signal (the requester's bell + the thread status event) rides the public_stage
 * crossing inside ticket.service and is deliberately not a webhook.
 */
import type { Ticket } from '@/lib/server/db'
import type { Actor } from '@/lib/server/policy/types'
import type { EventActor, EventTicketData, EventTicketRef } from '@/lib/server/events/types'
import {
  dispatchTicketCreated,
  dispatchTicketStatusChanged,
  dispatchTicketAssigned,
} from '@/lib/server/events/dispatch'
import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'ticket-webhooks' })

/** The actor is the teammate/requester who acted, never the ticket's requester
 *  (they differ when a teammate files on someone's behalf). No author email is
 *  carried: unlike a conversation message, a ticket write has no author record. */
function toEventActor(actor: Actor): EventActor {
  const principalId = actor.principalId ?? undefined
  if (actor.principalType === 'service') return { type: 'service', principalId }
  return { type: 'user', principalId }
}

function ticketRef(t: Ticket): EventTicketRef {
  return {
    id: t.id,
    number: t.number,
    type: t.type,
    priority: t.priority,
    assignedPrincipalId: t.assigneePrincipalId ?? null,
    assignedTeamId: t.assigneeTeamId ?? null,
  }
}

function ticketData(
  t: Ticket,
  status: { category: 'open' | 'pending' | 'closed'; stage: string | null }
): EventTicketData {
  return {
    ...ticketRef(t),
    title: t.title,
    status: status.category,
    stage: status.stage,
    requesterPrincipalId: t.requesterPrincipalId ?? null,
    companyId: t.companyId ?? null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    resolvedAt: t.resolvedAt ? t.resolvedAt.toISOString() : null,
  }
}

async function safe(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    log.warn({ err, label }, 'webhook failed')
  }
}

export async function emitTicketCreated(
  actor: Actor,
  ticket: Ticket,
  status: { category: 'open' | 'pending' | 'closed'; stage: string | null }
): Promise<void> {
  await safe('ticket.created', () =>
    dispatchTicketCreated(toEventActor(actor), ticketData(ticket, status))
  )
}

export async function emitTicketStatusChanged(
  actor: Actor,
  ticket: Ticket,
  previousStatus: 'open' | 'pending' | 'closed',
  newStatus: 'open' | 'pending' | 'closed',
  stage: string | null
): Promise<void> {
  await safe('ticket.status_changed', () =>
    dispatchTicketStatusChanged(
      toEventActor(actor),
      ticketRef(ticket),
      previousStatus,
      newStatus,
      stage
    )
  )
}

export async function emitTicketAssigned(
  actor: Actor,
  ticket: Ticket,
  previousPrincipalId: string | null,
  previousTeamId: string | null
): Promise<void> {
  await safe('ticket.assigned', () =>
    dispatchTicketAssigned(
      toEventActor(actor),
      ticketRef(ticket),
      ticket.assigneePrincipalId ?? null,
      previousPrincipalId,
      ticket.assigneeTeamId ?? null,
      previousTeamId
    )
  )
}
