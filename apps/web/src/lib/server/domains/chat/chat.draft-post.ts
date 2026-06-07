/**
 * Card-in-chat sends. An agent can drop a rich "card" into a conversation:
 *   - proposePost: a draft feedback post the visitor can publish (draft_post card).
 *   - sharePost:   an embedded reference to an existing post (post_ref card).
 *
 * Both mirror sendAgentMessage — server-decided 'agent' sender, conversation
 * touch + assignment claim, realtime broadcast, and the message.created webhook —
 * but stash the card under metadata.card so it flows through to the DTO.
 */
import { db, conversations, chatMessages, principal, posts, eq } from '@/lib/server/db'
import type { ConversationId, PostId, BoardId, PrincipalId, ChatMessageId } from '@quackback/ids'
import type { ChatCard } from '@/lib/shared/db-types'
import type { Actor, Role } from '@/lib/server/policy/types'
import { canActAsAgent } from '@/lib/server/policy/chat'
import { config } from '@/lib/server/config'
import { ForbiddenError, NotFoundError } from '@/lib/shared/errors'
import { toMessageDTO, resolveAuthor, conversationToDTO } from './chat.query'
import {
  publishChatEvent,
  publishConversationUpdate,
  publishCardUpdated,
} from '@/lib/server/realtime/chat-channels'
import { emitMessageCreated } from './chat.webhooks'
import { createPostFromConversation } from './chat.convert'
import { findSimilarPostsByText } from '@/lib/server/domains/embeddings/embedding.service'
import { addVoteOnBehalf } from '@/lib/server/domains/posts/post.voting'
import type { ChatAuthorInput, SendAgentMessageResult } from './chat.types'

export interface DraftPostAgentCtx {
  agentActor: Actor
  agentPrincipalId: PrincipalId
  agent: ChatAuthorInput
}

/**
 * Insert a card-carrying agent message + touch the conversation in one
 * transaction, then broadcast it. Agent-gated like every other agent write.
 */
async function insertCardMessage(
  conversationId: ConversationId,
  content: string,
  card: ChatCard,
  ctx: DraftPostAgentCtx
): Promise<SendAgentMessageResult> {
  const decision = canActAsAgent(ctx.agentActor)
  if (!decision.allowed) throw new ForbiddenError('FORBIDDEN', decision.reason)

  const txResult = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1)
    if (!existing) {
      throw new NotFoundError('CONVERSATION_NOT_FOUND', 'Conversation not found')
    }

    const [message] = await tx
      .insert(chatMessages)
      .values({
        conversationId,
        principalId: ctx.agent.principalId,
        senderType: 'agent',
        content,
        metadata: { card },
      })
      .returning()

    const [updated] = await tx
      .update(conversations)
      .set({
        lastMessageAt: message.createdAt,
        lastMessagePreview: content,
        // Posting a card claims the conversation if it's still unassigned.
        assignedAgentPrincipalId: existing.assignedAgentPrincipalId ?? ctx.agent.principalId,
        updatedAt: message.createdAt,
      })
      .where(eq(conversations.id, conversationId))
      .returning()

    return { message, conversation: updated }
  })

  const messageDTO = toMessageDTO(txResult.message, await resolveAuthor(ctx.agent))
  // Agent-side DTO so the inbox keeps agent-only fields; publishConversationUpdate
  // strips them from the visitor's copy.
  const conversationDTO = await conversationToDTO(txResult.conversation, 'agent')

  publishConversationUpdate(conversationDTO.id, conversationDTO)
  publishChatEvent(messageDTO.conversationId, {
    kind: 'message',
    conversationId: messageDTO.conversationId,
    message: messageDTO,
  })

  void emitMessageCreated(ctx.agentActor, ctx.agent, txResult.message, txResult.conversation)

  return { conversation: conversationDTO, message: messageDTO }
}

/** Agent proposes a draft feedback post (visitor can publish it). */
export function proposePost(
  input: { conversationId: ConversationId; boardId: BoardId; title: string; content: string },
  ctx: DraftPostAgentCtx
): Promise<SendAgentMessageResult> {
  const title = input.title.trim()
  const card: ChatCard = {
    type: 'draft_post',
    status: 'proposed',
    boardId: input.boardId,
    title,
    content: input.content,
  }
  return insertCardMessage(input.conversationId, `📝 Draft feedback: ${title}`, card, ctx)
}

/** Agent shares (embeds) an existing post into the conversation. */
export function sharePost(
  input: { conversationId: ConversationId; postId: PostId },
  ctx: DraftPostAgentCtx
): Promise<SendAgentMessageResult> {
  const card: ChatCard = { type: 'post_ref', postId: input.postId }
  return insertCardMessage(input.conversationId, `🔼 Shared a related idea`, card, ctx)
}

/**
 * Load a card-carrying message and assert the caller owns the conversation it
 * belongs to. The visitor-owns-conversation check is the security boundary for
 * the visitor-initiated card actions below — never relax it.
 */
async function loadOwnedCardMessage(messageId: ChatMessageId, visitorActor: Actor) {
  const [message] = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.id, messageId))
    .limit(1)
  if (!message) throw new NotFoundError('MESSAGE_NOT_FOUND', 'Message not found')

  const [conversation] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, message.conversationId))
    .limit(1)
  if (!conversation || conversation.visitorPrincipalId !== visitorActor.principalId) {
    throw new ForbiddenError('FORBIDDEN', 'Not your conversation')
  }
  return { message, conversation }
}

/**
 * Visitor declines a proposed draft post: flip the card to 'dismissed' and
 * broadcast. Idempotent — a no-op unless the card is a still-proposed draft.
 */
export async function dismissProposedPost(
  input: { messageId: ChatMessageId },
  visitorActor: Actor
): Promise<void> {
  const { message } = await loadOwnedCardMessage(input.messageId, visitorActor)
  const card = message.metadata?.card
  if (!card || card.type !== 'draft_post' || card.status !== 'proposed') return
  const next: ChatCard = { ...card, status: 'dismissed' }
  await db
    .update(chatMessages)
    .set({ metadata: { ...message.metadata, card: next } })
    .where(eq(chatMessages.id, message.id))
  publishCardUpdated(message.conversationId, message.id, next)
}

/**
 * Visitor upvotes an embedded post from chat. Reuses addVoteOnBehalf to vote as
 * the conversation's visitor (idempotent insert), attributed to the live-chat
 * source so the post links back to the inbox conversation.
 */
export async function upvotePostFromChat(
  input: { messageId: ChatMessageId; postId: PostId },
  visitorActor: Actor
): Promise<{ voteCount: number }> {
  const { conversation } = await loadOwnedCardMessage(input.messageId, visitorActor)
  const externalUrl = `${config.baseUrl.replace(/\/$/, '')}/admin/inbox?c=${conversation.id}`
  const res = await addVoteOnBehalf(
    input.postId,
    conversation.visitorPrincipalId,
    { type: 'live_chat', externalUrl },
    null,
    visitorActor.principalId ?? undefined
  )
  return { voteCount: res.voteCount }
}

/**
 * Build a policy Actor from a bare principal id. The visitor publishing a draft
 * has no agent authority, but the post must be created with the PROPOSING
 * agent's authority — they're always a team/service principal, so the
 * reconstructed actor's role satisfies canActAsAgent.
 */
async function actorForPrincipal(principalId: PrincipalId): Promise<Actor> {
  const [row] = await db
    .select({ id: principal.id, role: principal.role, type: principal.type })
    .from(principal)
    .where(eq(principal.id, principalId))
    .limit(1)
  if (!row) throw new NotFoundError('PRINCIPAL_NOT_FOUND', 'Principal not found')
  return {
    principalId: row.id,
    role: row.role as Role,
    principalType: row.type === 'service' ? 'service' : 'user',
    segmentIds: new Set(),
  }
}

// Only a STRONG semantic match blocks publishing: cosine ≥ 0.5 mirrors the
// "strong" band in findSimilarPostsFn (getMatchStrength). The 0.35 default the
// suggestion UI uses is "weak" and must NOT trigger publish-time dedupe.
const STRONG_DUPLICATE_THRESHOLD = 0.5

/**
 * Publish-time dedupe. Returns the single strongest existing post on the board
 * only when it's a STRONG match, mapped to the shape the UI needs to offer
 * vote-or-post-anyway. findSimilarPostsByText returns pure cosine similarity
 * without a vote count, so fetch that separately for the matched post.
 */
async function findStrongDuplicate(
  title: string,
  boardId: BoardId
): Promise<{ id: string; title: string; voteCount: number } | null> {
  const [match] = await findSimilarPostsByText(title, boardId, 1, STRONG_DUPLICATE_THRESHOLD)
  if (!match) return null
  const [row] = await db
    .select({ voteCount: posts.voteCount })
    .from(posts)
    .where(eq(posts.id, match.id))
    .limit(1)
  return { id: match.id, title: match.title, voteCount: row?.voteCount ?? 0 }
}

export interface PublishProposedPostResult {
  postId?: PostId
  created?: boolean
  boardSlug?: string | null
  /** A strong existing match the visitor should vote on instead of duplicating. */
  duplicate?: { id: string; title: string; voteCount: number }
}

/**
 * Visitor publishes a proposed draft post. Idempotent — a no-op unless the card
 * is a still-proposed draft. Runs publish-time dedupe first: a strong match
 * short-circuits without creating a post (the UI then offers vote-or-post-
 * anyway). Otherwise the post is created attributed to the visitor but with the
 * proposing agent's authority, and the card flips to published.
 */
export async function publishProposedPost(
  input: {
    messageId: ChatMessageId
    title: string
    content: string
    boardId: BoardId
    /** Bypass dedupe (the visitor chose "post anyway" after a duplicate prompt). */
    skipDedupe?: boolean
  },
  visitorActor: Actor
): Promise<PublishProposedPostResult> {
  const { message, conversation } = await loadOwnedCardMessage(input.messageId, visitorActor)
  const card = message.metadata?.card
  if (!card || card.type !== 'draft_post' || card.status !== 'proposed') return {}

  if (!input.skipDedupe) {
    const duplicate = await findStrongDuplicate(input.title, input.boardId)
    if (duplicate) return { duplicate }
  }

  // createPostFromConversation is agent-gated; run it with the proposing agent's
  // authority (the card message's principal) while it attributes the post to the
  // conversation's visitor. A draft_post card is always agent-authored, so a
  // null principal here is a data-integrity violation.
  const agentPrincipalId = message.principalId
  if (!agentPrincipalId) {
    throw new NotFoundError('PRINCIPAL_NOT_FOUND', 'Proposing agent not found')
  }
  const agentActor = await actorForPrincipal(agentPrincipalId)
  const result = await createPostFromConversation(
    {
      conversationId: conversation.id,
      boardId: input.boardId,
      title: input.title,
      content: input.content,
    },
    { agentActor, agentPrincipalId }
  )

  const next: ChatCard = {
    type: 'draft_post',
    status: 'published',
    boardId: input.boardId,
    title: input.title,
    content: input.content,
    postId: result.postId,
  }
  await db
    .update(chatMessages)
    .set({ metadata: { ...message.metadata, card: next } })
    .where(eq(chatMessages.id, message.id))
  publishCardUpdated(conversation.id, message.id, next)

  return { postId: result.postId, created: result.created, boardSlug: result.boardSlug }
}
