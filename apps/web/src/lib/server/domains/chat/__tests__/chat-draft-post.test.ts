/**
 * Card-in-chat sends: proposePost inserts an agent message carrying a
 * draft_post card; sharePost inserts one carrying a post_ref card. Both mirror
 * sendAgentMessage (server-decided 'agent' sender, conversation touch, realtime
 * broadcast) but stash the card under metadata.card so it flows to the DTO.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrincipalId, ConversationId, BoardId, PostId, ChatMessageId } from '@quackback/ids'
import type { Actor } from '@/lib/server/policy/types'
import { ForbiddenError } from '@/lib/shared/errors'

const insertedMessages: Record<string, unknown>[] = []
// Metadata patches passed to db.update(chatMessages).set(...) — dismiss flips the card.
const updatedMessageSets: Record<string, unknown>[] = []
const publishChatEvent = vi.fn()
const publishConversationUpdate = vi.fn()
const publishCardUpdated = vi.fn()

// Hoisted so the (also-hoisted) vi.mock factory can reference the spy bag.
const emit = vi.hoisted(() => ({
  emitConversationCreated: vi.fn(),
  emitMessageCreated: vi.fn(),
  emitMessageNoteCreated: vi.fn(),
  emitMessageDeleted: vi.fn(),
  emitConversationStatusChanged: vi.fn(),
  emitConversationAssigned: vi.fn(),
  emitConversationPriorityChanged: vi.fn(),
  emitConversationCsatSubmitted: vi.fn(),
}))
vi.mock('../chat.webhooks', () => emit)

// Hoisted bag for the publish path: the dedupe primitive, createPostFromConversation,
// and mutable db state (card status + the duplicate's vote count) the db mock reads.
const mocks = vi.hoisted(() => ({
  findSimilarPostsByText: vi.fn(),
  createPostFromConversation: vi.fn(),
  state: {
    cardType: 'draft_post' as 'draft_post' | 'post_ref',
    cardStatus: 'proposed' as 'proposed' | 'published' | 'dismissed',
    dupVoteCount: 0,
  },
}))

vi.mock('@/lib/server/domains/embeddings/embedding.service', () => ({
  findSimilarPostsByText: mocks.findSimilarPostsByText,
}))

vi.mock('../chat.convert', () => ({
  createPostFromConversation: mocks.createPostFromConversation,
}))

vi.mock('@/lib/server/realtime/chat-channels', () => ({
  publishChatEvent: (...args: unknown[]) => publishChatEvent(...args),
  publishAgentChatEvent: vi.fn(),
  publishConversationUpdate: (...args: unknown[]) => publishConversationUpdate(...args),
  publishCardUpdated: (...args: unknown[]) => publishCardUpdated(...args),
}))

vi.mock('@/lib/server/domains/posts/post.voting', () => ({
  addVoteOnBehalf: vi.fn(async () => ({ voted: true, voteCount: 1 })),
}))

vi.mock('@/lib/server/config', () => ({
  config: { s3PublicUrl: undefined, baseUrl: 'http://localhost:3000' },
  getBaseUrl: () => 'http://localhost:3000',
}))

vi.mock('../chat.query', () => ({
  conversationToDTO: vi.fn(async (c: { id: string; status: string }) => ({
    id: c.id,
    status: c.status,
  })),
  // Project the fields the assertions read: server-decided senderType and the
  // card stashed under metadata.card (mirrors the real toMessageDTO).
  toMessageDTO: vi.fn((m: Record<string, unknown>) => ({
    id: m.id,
    conversationId: m.conversationId,
    senderType: m.senderType,
    content: m.content,
    author: { principalId: m.principalId, displayName: null, avatarUrl: null },
    card: (m.metadata as { card?: unknown } | null)?.card ?? null,
  })),
  resolveAuthor: vi.fn(async (a: { principalId: string }) => ({
    principalId: a.principalId,
    displayName: null,
    avatarUrl: null,
  })),
  authorFromInput: vi.fn((a: { principalId: string }) => ({
    principalId: a.principalId,
    displayName: null,
    avatarUrl: null,
  })),
  loadAuthors: vi.fn(async () => new Map()),
}))

vi.mock('@/lib/server/db', () => {
  const conversationRow = {
    id: 'conversation_1' as unknown as ConversationId,
    visitorPrincipalId: 'principal_visitor',
    assignedAgentPrincipalId: null,
    status: 'open',
    subject: null,
    lastMessagePreview: null,
    lastMessageAt: new Date(),
    visitorLastReadAt: null,
    agentLastReadAt: null,
    createdAt: new Date(),
    updatedAt: null,
  }

  // The proposing agent's principal row, loaded by actorForPrincipal so the
  // publish path can act with the agent's (team) authority.
  const principalRow = { id: 'principal_agent', role: 'admin', type: 'user' }

  // A chat message carrying a card, owned by the visitor. The card type/status
  // are read from mocks.state so a single mock serves the proposed/published
  // cases (the published case exercises the idempotent no-op).
  function buildMessageRow() {
    return {
      id: 'chat_msg_card' as unknown as ChatMessageId,
      conversationId: 'conversation_1' as unknown as ConversationId,
      principalId: 'principal_agent',
      senderType: 'agent' as const,
      content: '📝 Draft feedback: Dark mode',
      metadata: {
        card:
          mocks.state.cardType === 'draft_post'
            ? {
                type: 'draft_post',
                status: mocks.state.cardStatus,
                boardId: 'board_1',
                title: 'Dark mode',
                content: 'A dark theme…',
              }
            : { type: 'post_ref', postId: 'post_1' },
      },
      createdAt: new Date(),
    }
  }

  function chain(label: string) {
    const c: Record<string, unknown> = {}
    let fromTable: string | undefined
    c.values = vi.fn((row: Record<string, unknown>) => {
      if (label === 'chat_messages') insertedMessages.push(row)
      return c
    })
    c.set = vi.fn((row: Record<string, unknown>) => {
      if (label === 'chat_messages') updatedMessageSets.push(row)
      return c
    })
    c.from = vi.fn((table?: { __name?: string }) => {
      fromTable = table?.__name
      return c
    })
    c.where = vi.fn(() => c)
    // A direct select resolves to the table-appropriate row; the in-transaction
    // conversation lookup still resolves to an existing conversation.
    c.limit = vi.fn(async () => {
      if (fromTable === 'chat_messages') return [buildMessageRow()]
      if (fromTable === 'principal') return [principalRow]
      if (fromTable === 'posts') return [{ voteCount: mocks.state.dupVoteCount }]
      return [conversationRow]
    })
    c.orderBy = vi.fn(() => c)
    c.returning = vi.fn(async () => {
      if (label === 'chat_messages') {
        const last = insertedMessages.at(-1) ?? {}
        return [{ ...last, id: 'chat_msg_new', createdAt: new Date() }]
      }
      if (label === 'conversations') {
        return [{ ...conversationRow }]
      }
      return []
    })
    return c
  }

  const tx = {
    select: () => chain('select'),
    insert: (table: { __name?: string }) => chain(table?.__name ?? 'unknown'),
    update: (table: { __name?: string }) => chain(table?.__name ?? 'unknown'),
  }

  return {
    db: {
      transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
      select: vi.fn(() => chain('select')),
      insert: vi.fn((table: { __name?: string }) => chain(table?.__name ?? 'unknown')),
      update: vi.fn((table: { __name?: string }) => chain(table?.__name ?? 'unknown')),
    },
    eq: vi.fn(),
    conversations: { __name: 'conversations', id: 'id' },
    chatMessages: { __name: 'chat_messages', id: 'id' },
    principal: { __name: 'principal', id: 'id', role: 'role', type: 'type' },
    posts: { __name: 'posts', id: 'id', voteCount: 'vote_count' },
  }
})

import { addVoteOnBehalf } from '@/lib/server/domains/posts/post.voting'
import {
  dismissProposedPost,
  proposePost,
  publishProposedPost,
  sharePost,
  upvotePostFromChat,
} from '../chat.draft-post'

const conversationId = 'conversation_1' as ConversationId
const boardId = 'board_1' as BoardId
const postId = 'post_1' as PostId
const agentPrincipalId = 'principal_agent' as PrincipalId
const agent = {
  principalId: agentPrincipalId,
  displayName: 'Jane',
  email: null,
}
const agentActor: Actor = {
  principalId: agentPrincipalId,
  role: 'admin',
  principalType: 'user',
  segmentIds: new Set(),
}
const visitorActor: Actor = {
  principalId: 'principal_visitor' as PrincipalId,
  role: 'user',
  principalType: 'anonymous',
  segmentIds: new Set(),
}
// Owns a different conversation — fails the visitor-owns-conversation guard.
const strangerActor: Actor = {
  principalId: 'principal_stranger' as PrincipalId,
  role: 'user',
  principalType: 'anonymous',
  segmentIds: new Set(),
}
const messageId = 'chat_msg_card' as ChatMessageId

beforeEach(() => {
  insertedMessages.length = 0
  updatedMessageSets.length = 0
  vi.clearAllMocks()
  mocks.state.cardType = 'draft_post'
  mocks.state.cardStatus = 'proposed'
  mocks.state.dupVoteCount = 0
  mocks.findSimilarPostsByText.mockResolvedValue([])
  mocks.createPostFromConversation.mockResolvedValue({
    postId: 'post_new',
    created: true,
    boardSlug: 'feature-requests',
  })
})

describe('proposePost', () => {
  it('inserts an agent message carrying a draft_post card', async () => {
    const { message } = await proposePost(
      { conversationId, boardId, title: 'Dark mode', content: 'A dark theme…' },
      { agentActor, agentPrincipalId, agent }
    )
    expect(message.senderType).toBe('agent')
    expect(message.card).toEqual({
      type: 'draft_post',
      status: 'proposed',
      boardId,
      title: 'Dark mode',
      content: 'A dark theme…',
    })
    // The stored row is agent-typed and stashes the card under metadata.card.
    expect(insertedMessages).toHaveLength(1)
    expect(insertedMessages[0]).toMatchObject({
      conversationId,
      principalId: agentPrincipalId,
      senderType: 'agent',
      metadata: {
        card: { type: 'draft_post', status: 'proposed', boardId, title: 'Dark mode' },
      },
    })
  })

  it('refuses a non-agent actor before any write', async () => {
    await expect(
      proposePost(
        { conversationId, boardId, title: 'Dark mode', content: 'x' },
        { agentActor: visitorActor, agentPrincipalId, agent }
      )
    ).rejects.toBeInstanceOf(ForbiddenError)
    expect(insertedMessages).toHaveLength(0)
  })
})

describe('sharePost', () => {
  it('inserts an agent message carrying a post_ref card', async () => {
    const shared = await sharePost(
      { conversationId, postId },
      { agentActor, agentPrincipalId, agent }
    )
    expect(shared.message.senderType).toBe('agent')
    expect(shared.message.card).toEqual({ type: 'post_ref', postId })
    expect(insertedMessages[0]).toMatchObject({
      senderType: 'agent',
      metadata: { card: { type: 'post_ref', postId } },
    })
  })
})

describe('dismissProposedPost', () => {
  it('flips a proposed draft to dismissed (and is a no-op if not proposed)', async () => {
    await dismissProposedPost({ messageId }, visitorActor)
    // The card row is patched to dismissed and the change is broadcast.
    expect(updatedMessageSets).toHaveLength(1)
    expect(updatedMessageSets[0]).toMatchObject({
      metadata: { card: { type: 'draft_post', status: 'dismissed' } },
    })
    expect(publishCardUpdated).toHaveBeenCalledTimes(1)
    const [, , card] = publishCardUpdated.mock.calls[0]
    expect(card).toMatchObject({ type: 'draft_post', status: 'dismissed' })
  })

  it('rejects a caller who does not own the conversation', async () => {
    await expect(dismissProposedPost({ messageId }, strangerActor)).rejects.toBeInstanceOf(
      ForbiddenError
    )
    expect(updatedMessageSets).toHaveLength(0)
    expect(publishCardUpdated).not.toHaveBeenCalled()
  })
})

describe('upvotePostFromChat', () => {
  it('adds a vote on the visitor’s behalf and returns the vote count', async () => {
    const res = await upvotePostFromChat({ messageId, postId }, visitorActor)
    expect(res.voteCount).toBeGreaterThanOrEqual(1)
    // Votes for the conversation's visitor, attributed to the live-chat source.
    expect(addVoteOnBehalf).toHaveBeenCalledWith(
      postId,
      'principal_visitor',
      { type: 'live_chat', externalUrl: 'http://localhost:3000/admin/inbox?c=conversation_1' },
      null,
      visitorActor.principalId
    )
  })

  it('rejects a caller who does not own the conversation', async () => {
    await expect(upvotePostFromChat({ messageId, postId }, strangerActor)).rejects.toBeInstanceOf(
      ForbiddenError
    )
    expect(addVoteOnBehalf).not.toHaveBeenCalled()
  })
})

describe('publishProposedPost', () => {
  it('creates a visitor-attributed post and flips the card to published when no strong duplicate', async () => {
    mocks.findSimilarPostsByText.mockResolvedValue([])

    const res = await publishProposedPost(
      { messageId, title: 'New idea', content: 'details', boardId },
      visitorActor
    )

    expect(res.postId).toBe('post_new')
    expect(res.created).toBe(true)
    expect(res.boardSlug).toBe('feature-requests')

    // Dedupe ran with the STRONG cosine threshold (0.5) — weaker matches must
    // not block publishing.
    expect(mocks.findSimilarPostsByText).toHaveBeenCalledWith('New idea', boardId, 1, 0.5)

    // The post was created with the PROPOSING AGENT's authority (reconstructed
    // from the card message's principal), not the visitor's.
    expect(mocks.createPostFromConversation).toHaveBeenCalledTimes(1)
    const [convInput, ctx] = mocks.createPostFromConversation.mock.calls[0]
    expect(convInput).toMatchObject({
      conversationId: 'conversation_1',
      boardId,
      title: 'New idea',
      content: 'details',
    })
    expect(ctx.agentPrincipalId).toBe('principal_agent')
    expect(ctx.agentActor).toMatchObject({ principalId: 'principal_agent', role: 'admin' })

    // The card row is flipped to published (with the new postId) and broadcast.
    expect(updatedMessageSets).toHaveLength(1)
    expect(updatedMessageSets[0]).toMatchObject({
      metadata: { card: { type: 'draft_post', status: 'published', postId: 'post_new' } },
    })
    expect(publishCardUpdated).toHaveBeenCalledTimes(1)
    const [, , card] = publishCardUpdated.mock.calls[0]
    expect(card).toMatchObject({ type: 'draft_post', status: 'published', postId: 'post_new' })
  })

  it('returns a duplicate (no post created) when a strong match exists', async () => {
    mocks.findSimilarPostsByText.mockResolvedValue([
      { id: 'post_existing', title: 'existing', similarity: 0.92 },
    ])
    mocks.state.dupVoteCount = 7

    const res = await publishProposedPost(
      { messageId, title: 'existing', content: 'x', boardId },
      visitorActor
    )

    expect(res.duplicate).toEqual({ id: 'post_existing', title: 'existing', voteCount: 7 })
    expect(res.postId).toBeUndefined()
    // No post created, card untouched, nothing broadcast.
    expect(mocks.createPostFromConversation).not.toHaveBeenCalled()
    expect(updatedMessageSets).toHaveLength(0)
    expect(publishCardUpdated).not.toHaveBeenCalled()
  })

  it('is a no-op when the card is not a proposed draft', async () => {
    mocks.state.cardStatus = 'published'

    const res = await publishProposedPost(
      { messageId, title: 't', content: 'c', boardId },
      visitorActor
    )

    expect(res).toEqual({})
    expect(mocks.findSimilarPostsByText).not.toHaveBeenCalled()
    expect(mocks.createPostFromConversation).not.toHaveBeenCalled()
    expect(updatedMessageSets).toHaveLength(0)
    expect(publishCardUpdated).not.toHaveBeenCalled()
  })

  it('rejects a caller who does not own the conversation', async () => {
    await expect(
      publishProposedPost({ messageId, title: 't', content: 'c', boardId }, strangerActor)
    ).rejects.toBeInstanceOf(ForbiddenError)
    expect(mocks.createPostFromConversation).not.toHaveBeenCalled()
    expect(updatedMessageSets).toHaveLength(0)
  })
})
