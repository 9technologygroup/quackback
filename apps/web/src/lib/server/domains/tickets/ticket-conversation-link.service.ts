/**
 * Link a ticket to the conversation it was created from (unified inbox §M5's
 * create-ticket flow): inserts the `ticket_conversations` join row, announces
 * the ticket on the conversation thread as a system event (mirrors
 * ticket-links.service.ts's tracker-link note, but on the CONVERSATION side —
 * `emitSystemMessage`'s content is agent-facing plain English, never sent to
 * the customer), and lets that same insert/publish keep any open inbox tab in
 * sync. Customer tickets only: the partial-unique index
 * (`ticket_conversations_customer_uq`) allows at most one CUSTOMER ticket per
 * conversation, surfaced here as a friendly `ConflictError` instead of a raw
 * constraint violation should two teammates race to link the same
 * conversation.
 */
import { db, eq, conversations, ticketConversations } from '@/lib/server/db'
import type { ConversationId, TicketId } from '@quackback/ids'
import { can } from '@/lib/server/policy/authorize'
import type { Actor } from '@/lib/server/policy/types'
import { PERMISSIONS } from '@/lib/shared/permissions'
import { ForbiddenError, ValidationError, ConflictError, NotFoundError } from '@/lib/shared/errors'
import { isUniqueViolation } from '@/lib/server/utils'
import { formatTicketNumber } from '@/lib/shared/tickets'
import { logger } from '@/lib/server/logger'
import { loadTicketOr404 } from './ticket.service'

const log = logger.child({ component: 'ticket-conversation-link' })

/**
 * Link `ticketId` (must be type 'customer') to `conversationId`. Gated on
 * `ticket.create` — this is only ever called as the second step of the
 * create-ticket flow (createTicketFn then linkTicketToConversationFn), never
 * as a standalone re-link action.
 */
export async function linkTicketToConversation(
  ticketId: TicketId,
  conversationId: ConversationId,
  actor: Actor
): Promise<void> {
  if (!can(actor, PERMISSIONS.TICKET_CREATE)) {
    throw new ForbiddenError('FORBIDDEN', 'You cannot link a ticket to a conversation')
  }

  const ticket = await loadTicketOr404(ticketId)
  if (ticket.type !== 'customer') {
    throw new ValidationError(
      'INVALID_LINK',
      'Only customer tickets can be linked to a conversation'
    )
  }

  const [conversation] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1)
  if (!conversation) {
    throw new NotFoundError('NOT_FOUND', 'Conversation not found')
  }

  try {
    await db.insert(ticketConversations).values({
      ticketId,
      conversationId,
      ticketType: 'customer',
      linkedByPrincipalId: actor.principalId ?? null,
    })
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError('ALREADY_LINKED', 'This conversation already has a linked ticket')
    }
    throw err
  }

  // Best-effort announcement: the link itself already landed, so a failure
  // here (e.g. the conversation was deleted a moment later) must not surface
  // as an error to the caller — emitSystemMessage already swallows its own.
  const { emitSystemMessage } =
    await import('@/lib/server/domains/conversation/conversation.service')
  const reference = formatTicketNumber(ticket.number)
  await emitSystemMessage(conversationId, `Ticket ${reference} created from this conversation`, {
    kind: 'ticket_created',
    ticketReference: reference,
  })

  log.info(
    { ticket_id: ticketId, conversation_id: conversationId },
    'ticket linked to conversation'
  )
}
