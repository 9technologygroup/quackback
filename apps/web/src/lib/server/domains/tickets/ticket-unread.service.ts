/**
 * Ticket read receipts (unified inbox §3.3), mirroring the conversation unread
 * model (conversation.query.ts's unreadCountFor / batched list-unread query,
 * conversation.service.ts's markConversationRead) but against
 * conversation_messages WHERE ticket_id = X. A ticket message's senderType
 * discriminates the side ('agent' == assignee, 'visitor' == requester) the
 * same way ticket-message.service.ts's insertTicketMessage does; internal
 * notes and soft-deleted messages never count toward either side's unread.
 */
import {
  db,
  conversationMessages,
  tickets,
  eq,
  and,
  or,
  inArray,
  isNull,
  gt,
  sql,
} from '@/lib/server/db'
import type { TicketId, ConversationMessageId } from '@quackback/ids'
import { publishTicketEvent } from '@/lib/server/realtime/conversation-channels'
import { unreadWatermarkFromAnchor } from '@/lib/server/domains/conversation/conversation.lifecycle'
import { assertTicketVisible } from './ticket.service'
import { canActAsAgent } from '@/lib/server/policy/conversation'
import type { Actor } from '@/lib/server/policy/types'
import { NotFoundError, ForbiddenError } from '@/lib/shared/errors'

export type TicketUnreadSide = 'requester' | 'assignee'

/** Count messages on the other side that arrived after this side last read. */
export async function unreadCountForTicket(
  ticketId: TicketId,
  side: TicketUnreadSide
): Promise<number> {
  const [ticket] = await db
    .select({
      requesterLastReadAt: tickets.requesterLastReadAt,
      assigneeLastReadAt: tickets.assigneeLastReadAt,
    })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
  const otherSide = side === 'assignee' ? 'visitor' : 'agent'
  const readAt = side === 'assignee' ? ticket?.assigneeLastReadAt : ticket?.requesterLastReadAt

  const [row] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.ticketId, ticketId),
        eq(conversationMessages.senderType, otherSide),
        isNull(conversationMessages.deletedAt),
        // Internal notes never count toward unread (esp. for the requester side).
        eq(conversationMessages.isInternal, false),
        // Use the gt() operator (not a raw sql template) so the Date watermark
        // is bound through Drizzle's timestamp encoder, mirroring
        // conversation.query.ts's unreadCountFor.
        readAt ? gt(conversationMessages.createdAt, readAt) : undefined
      )
    )
  return row?.c ?? 0
}

/**
 * Batched requester-authored unread count for a page of tickets, for list
 * enrichment (mirrors conversation.query.ts's listConversationsForAgent
 * unread-rows query). Only tickets with at least one unread message appear in
 * the returned map.
 */
export async function ticketUnreadMapForAgent(
  ticketIds: TicketId[]
): Promise<Map<TicketId, number>> {
  const map = new Map<TicketId, number>()
  if (ticketIds.length === 0) return map

  const rows = await db
    .select({
      ticketId: conversationMessages.ticketId,
      c: sql<number>`count(*)::int`,
    })
    .from(conversationMessages)
    .innerJoin(tickets, eq(tickets.id, conversationMessages.ticketId))
    .where(
      and(
        inArray(conversationMessages.ticketId, ticketIds),
        eq(conversationMessages.senderType, 'visitor'),
        isNull(conversationMessages.deletedAt),
        // Internal notes never count toward unread — defense-in-depth
        // mirroring unreadCountForTicket (visitor messages are never internal).
        eq(conversationMessages.isInternal, false),
        or(
          isNull(tickets.assigneeLastReadAt),
          sql`${conversationMessages.createdAt} > ${tickets.assigneeLastReadAt}`
        )
      )
    )
    .groupBy(conversationMessages.ticketId)

  // The inner join on tickets guarantees a non-null ticket_id.
  for (const row of rows) map.set(row.ticketId as TicketId, row.c)
  return map
}

/** Mark a ticket read for the assignee (agent) side. Publishes a 'ticket_read'
 *  (unified inbox §3.2, M3) so another tab/teammate's open thread or inbox
 *  list clears the badge live — `side: 'agent'` mirrors the conversation
 *  domain's read event exactly (see conversation-channels.ts). */
export async function markTicketReadForAgent(
  ticketId: TicketId,
  at: Date = new Date()
): Promise<void> {
  await db.update(tickets).set({ assigneeLastReadAt: at }).where(eq(tickets.id, ticketId))
  publishTicketEvent(ticketId, {
    kind: 'ticket_read',
    ticketId,
    side: 'agent',
    at: at.toISOString(),
  })
}

/** Mark a ticket read for the requester side. Published as `side: 'visitor'`
 *  for symmetry, though nothing in the agent inbox reacts to it today (see
 *  `agentEventChangesInboxList`'s `ticket_read` branch). */
export async function markTicketReadForRequester(
  ticketId: TicketId,
  at: Date = new Date()
): Promise<void> {
  await db.update(tickets).set({ requesterLastReadAt: at }).where(eq(tickets.id, ticketId))
  publishTicketEvent(ticketId, {
    kind: 'ticket_read',
    ticketId,
    side: 'visitor',
    at: at.toISOString(),
  })
}

/**
 * "Mark unread from here" for a ticket thread — the assignee-side sibling of
 * conversation.service.ts's `markConversationUnreadFromMessage`, against
 * `tickets.assigneeLastReadAt` instead of `conversations.agentLastReadAt`.
 * Deliberately a separate function (not a branch inside the conversation one):
 * the conversation-side fn is owned by a concurrent client integration this
 * task must not disturb.
 *
 * Agent-gated (`canActAsAgent` — only a team member can move their own read
 * watermark) and ticket-visibility-gated (`assertTicketVisible` — a
 * `ticket.view`-holding agent may only rewind a watermark on a ticket they can
 * actually see, not any ticket in the workspace); the anchor message must
 * belong to `ticketId` and not be soft-deleted. Reuses the shared, pure
 * `unreadWatermarkFromAnchor` (backward-only) so the date logic isn't
 * duplicated between the conversation and ticket domains. Published on the
 * ticket channel as `ticket_read` (unified inbox §3.2, M3) — the same event
 * kind `markTicketReadForAgent` already emits, so no new SSE contract.
 */
export async function markTicketUnreadFromMessage(
  ticketId: TicketId,
  messageId: ConversationMessageId,
  actor: Actor
): Promise<void> {
  const ticket = await assertTicketVisible(ticketId, actor)
  const decision = canActAsAgent(actor)
  if (!decision.allowed) throw new ForbiddenError('FORBIDDEN', decision.reason)

  // The anchor must belong to this ticket and not be soft-deleted.
  const [message] = await db
    .select({
      createdAt: conversationMessages.createdAt,
      deletedAt: conversationMessages.deletedAt,
    })
    .from(conversationMessages)
    .where(and(eq(conversationMessages.id, messageId), eq(conversationMessages.ticketId, ticketId)))
    .limit(1)
  if (!message || message.deletedAt) {
    throw new NotFoundError('MESSAGE_NOT_FOUND', 'Message not found')
  }

  const watermark = unreadWatermarkFromAnchor(ticket.assigneeLastReadAt, message.createdAt)
  await db.update(tickets).set({ assigneeLastReadAt: watermark }).where(eq(tickets.id, ticketId))
  publishTicketEvent(ticketId, {
    kind: 'ticket_read',
    ticketId,
    side: 'agent',
    at: (watermark ?? new Date(0)).toISOString(),
  })
}
