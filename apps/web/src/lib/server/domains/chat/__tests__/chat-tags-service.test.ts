/**
 * Guards for conversation tags: agent-only, unknown/soft-deleted tag ids are
 * dropped, and a tag change is published to the agent inbox ONLY (a tag is an
 * agent triage concern and must never reach the visitor's conversation channel).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrincipalId, ConversationId, TagId } from '@quackback/ids'
import type { Actor } from '@/lib/server/policy/types'
import { ForbiddenError } from '@/lib/shared/errors'

const insertedTagRows: Array<{ conversationId: string; tagId: string }> = []
let deletedTagsForConversation = false
const publishChatEvent = vi.fn()
const publishAgentChatEvent = vi.fn()

// Only tag_known is a real, non-deleted tag; tag_missing must be dropped.
const validTagIds = new Set(['tag_known'])

vi.mock('@/lib/server/realtime/chat-channels', () => ({
  publishChatEvent: (...args: unknown[]) => publishChatEvent(...args),
  publishAgentChatEvent: (...args: unknown[]) => publishAgentChatEvent(...args),
  publishConversationUpdate: vi.fn(),
}))

vi.mock('@/lib/server/config', () => ({
  config: { s3PublicUrl: undefined, baseUrl: 'http://localhost:3000' },
  getBaseUrl: () => 'http://localhost:3000',
}))

vi.mock('../chat.notify', () => ({
  notifyVisitorMessage: vi.fn(),
  notifyAgentReply: vi.fn(),
  notifyNoteMentions: vi.fn(),
}))

vi.mock('../chat.query', () => ({
  conversationToDTO: vi.fn(async (c: { id: string }) => ({ id: c.id, tags: [] })),
  toMessageDTO: vi.fn((m: Record<string, unknown>) => m),
  authorFromInput: vi.fn((a: { principalId: string }) => ({ principalId: a.principalId })),
  loadAuthors: vi.fn(async () => new Map()),
}))

vi.mock('@/lib/server/db', () => {
  const conversationRow = { id: 'conversation_1', status: 'open' }

  // A thenable query chain: `.from(table)` records which table we're reading so
  // `await`-ing the chain (or calling `.limit()`) returns table-appropriate rows.
  function selectChain(requestedTagIds?: string[]) {
    let label = 'unknown'
    const rows = () => {
      if (label === 'conversations') return [conversationRow]
      if (label === 'tags')
        return (requestedTagIds ?? []).filter((id) => validTagIds.has(id)).map((id) => ({ id }))
      return []
    }
    const c: Record<string, unknown> = {}
    c.from = (t: { __name?: string }) => {
      label = t?.__name ?? 'unknown'
      return c
    }
    c.where = () => c
    c.limit = async () => rows()
    c.orderBy = () => c
    c.innerJoin = () => c
    c.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(rows()).then(resolve, reject)
    return c
  }

  const tx = {
    delete: vi.fn(() => ({
      where: async () => {
        deletedTagsForConversation = true
        return []
      },
    })),
    insert: vi.fn(() => ({
      values: async (rows: Array<{ conversationId: string; tagId: string }>) => {
        insertedTagRows.push(...rows)
        return []
      },
    })),
  }

  let lastRequestedTagIds: string[] | undefined
  return {
    db: {
      // setConversationTags calls db.select() for loadConversationOr404 (reads
      // conversations) and db.select({id}) for tag validation (reads tags). We
      // can't see the inArray args here, so expose a setter the test primes.
      select: vi.fn(() => selectChain(lastRequestedTagIds)),
      transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
      __setRequestedTagIds: (ids: string[]) => {
        lastRequestedTagIds = ids
      },
    },
    eq: vi.fn(),
    and: vi.fn(),
    isNull: vi.fn(),
    inArray: vi.fn(),
    conversations: { __name: 'conversations', id: 'id' },
    conversationTags: { __name: 'conversation_tags', conversationId: 'conversation_id' },
    chatMessages: { __name: 'chat_messages', id: 'id' },
    tags: { __name: 'tags', id: 'id' },
  }
})

import { setConversationTags } from '../chat.service'
import { db } from '@/lib/server/db'

const conversationId = 'conversation_1' as ConversationId
const agentActor: Actor = {
  principalId: 'principal_agent' as PrincipalId,
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

beforeEach(() => {
  insertedTagRows.length = 0
  deletedTagsForConversation = false
  vi.clearAllMocks()
})

describe('setConversationTags', () => {
  it('refuses a non-agent actor', async () => {
    await expect(
      setConversationTags(conversationId, ['tag_known' as TagId], visitorActor)
    ).rejects.toBeInstanceOf(ForbiddenError)
    expect(insertedTagRows).toHaveLength(0)
  })

  it('drops unknown/soft-deleted tag ids and only inserts valid ones', async () => {
    ;(db as unknown as { __setRequestedTagIds: (ids: string[]) => void }).__setRequestedTagIds([
      'tag_known',
      'tag_missing',
    ])
    await setConversationTags(
      conversationId,
      ['tag_known' as TagId, 'tag_missing' as TagId],
      agentActor
    )
    expect(deletedTagsForConversation).toBe(true)
    expect(insertedTagRows).toEqual([{ conversationId, tagId: 'tag_known' }])
  })

  it('publishes the change to the agent inbox ONLY', async () => {
    ;(db as unknown as { __setRequestedTagIds: (ids: string[]) => void }).__setRequestedTagIds([
      'tag_known',
    ])
    await setConversationTags(conversationId, ['tag_known' as TagId], agentActor)
    expect(publishAgentChatEvent).toHaveBeenCalledTimes(1)
    expect(publishChatEvent).not.toHaveBeenCalled()
  })

  it('clears all tags when given an empty set', async () => {
    ;(db as unknown as { __setRequestedTagIds: (ids: string[]) => void }).__setRequestedTagIds([])
    await setConversationTags(conversationId, [], agentActor)
    expect(deletedTagsForConversation).toBe(true)
    expect(insertedTagRows).toHaveLength(0)
  })
})
