import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createId } from '@quackback/ids'
import type { DomainEvent } from '../envelope'

/**
 * Every event type the webhook API accepts must be deliverable: subscribing to
 * a type that never fires is a silent failure. The accepted list
 * (WEBHOOK_EVENTS), the admin picker (WEBHOOK_EVENT_CONFIG) and the catalogue's
 * exposure.webhook set must describe the same events.
 */

const boardA = createId('board')
const boardB = createId('board')

function hook(events: string[], boardIds: string[] | null) {
  return { id: createId('webhook'), url: 'https://example.com/hook', events, boardIds }
}

let active: ReturnType<typeof hook>[] = []
let postRow: { boardId: string } | undefined

vi.mock('@/lib/server/db', () => ({
  db: {
    query: {
      webhooks: { findMany: vi.fn(async () => active) },
      posts: { findFirst: vi.fn(async () => postRow) },
    },
  },
  webhooks: {},
  posts: {},
  and: vi.fn(),
  eq: vi.fn(),
  isNull: vi.fn(),
}))
vi.mock('@/lib/server/cache', () => ({
  cacheGet: vi.fn(async () => active),
  cacheSet: vi.fn(),
  CACHE_KEYS: { ACTIVE_WEBHOOKS: 'active-webhooks' },
}))

const { webhookResolver, boardIdsFromEvent } = await import('../resolvers/webhook.resolver')
const { WEBHOOK_EVENTS, WEBHOOK_EVENT_CONFIG } = await import('../integrations/webhook/constants')
const { webhookEventTypes } = await import('../catalogue')

function evt(type: string, payload: Record<string, unknown>): DomainEvent {
  return {
    eventId: createId('event'),
    seq: 1n,
    type,
    entityType: 'post',
    entityId: createId('post'),
    actorType: 'user',
    payload,
    context: { depth: 0 },
    schemaVersion: 1,
    occurredAt: new Date(),
  }
}

const principal = createId('principal')
const postId = createId('post')

const SILENT_EVENTS: Array<[string, Record<string, unknown>]> = [
  [
    'post.mentioned',
    {
      postId,
      postTitle: 'T',
      postUrl: 'https://x/p',
      boardId: boardA,
      mentionedPrincipalId: principal,
      mentioningPrincipalId: principal,
      excerpt: 'hi',
    },
  ],
  [
    'post.owner_assigned',
    {
      postId,
      postTitle: 'T',
      boardSlug: 'b',
      boardId: boardA,
      postUrl: 'https://x/p',
      ownerPrincipalId: principal,
      previousOwnerPrincipalId: null,
    },
  ],
  ['status.incident_created', { incident: { id: 'i', componentIds: [] } }],
  ['status.incident_updated', { incidentId: 'i', kind: 'update', status: 'x', body: 'b' }],
  ['status.maintenance_scheduled', { incident: { id: 'i', componentIds: [] } }],
  ['status.maintenance_started', { incidentId: 'i', title: 't', componentIds: [] }],
  ['status.maintenance_completed', { incidentId: 'i', title: 't', componentIds: [] }],
  [
    'status.component_changed',
    { componentId: 'c', componentName: 'n', previousStatus: 'a', status: 'b', source: 'manual' },
  ],
]

describe('previously silent webhook events', () => {
  beforeEach(() => {
    active = []
  })

  it.each(SILENT_EVENTS)('%s is webhook-exposed and yields a delivery target', async (type, p) => {
    expect(webhookResolver.interestedIn(type)).toBe(true)
    const w = hook([type], null)
    active = [w, hook(['post.created'], null)]
    const targets = await webhookResolver.resolve(evt(type, p))
    expect(targets.map((t) => t.config)).toEqual([{ webhookId: w.id }])
  })

  it('post-scoped new events honor board filters', async () => {
    for (const [type, p] of SILENT_EVENTS.slice(0, 2)) {
      expect(boardIdsFromEvent(evt(type, p))).toEqual([boardA])
      const other = hook([type], [boardB])
      const same = hook([type], [boardA])
      active = [other, same]
      const targets = await webhookResolver.resolve(evt(type, p))
      expect(targets.map((t) => t.config)).toEqual([{ webhookId: same.id }])
    }
  })

  it('status events have no board, so they follow the board-less rule (type match alone)', async () => {
    const filtered = hook(['status.incident_created'], [boardA])
    active = [filtered]
    const [type, p] = SILENT_EVENTS[2]
    expect(boardIdsFromEvent(evt(type, p))).toEqual([])
    const targets = await webhookResolver.resolve(evt(type, p))
    expect(targets).toHaveLength(1)
  })
})

describe('events queued before the payload carried a board', () => {
  beforeEach(() => {
    active = []
    postRow = undefined
  })
  const legacy = (): DomainEvent => {
    const { boardId: _boardId, ...payload } = SILENT_EVENTS[0][1]
    return evt('post.mentioned', payload)
  }

  it('looks up the post board so a webhook filtered to another board is skipped', async () => {
    postRow = { boardId: boardA }
    const other = hook(['post.mentioned'], [boardB])
    const same = hook(['post.mentioned'], [boardA])
    const open = hook(['post.mentioned'], null)
    active = [other, same, open]
    const targets = await webhookResolver.resolve(legacy())
    expect(targets.map((t) => t.config)).toEqual([{ webhookId: same.id }, { webhookId: open.id }])
  })

  it('with the post gone, reaches only webhooks that have no board filter', async () => {
    postRow = undefined
    const filtered = hook(['post.mentioned'], [boardA])
    const open = hook(['post.mentioned'], null)
    active = [filtered, open]
    const targets = await webhookResolver.resolve(legacy())
    expect(targets.map((t) => t.config)).toEqual([{ webhookId: open.id }])
  })
})

describe('accepted webhook events equal deliverable events', () => {
  it('WEBHOOK_EVENTS (accepted by POST /api/v1/webhooks) equals the catalogue webhook set', () => {
    expect(new Set<string>(WEBHOOK_EVENTS)).toEqual(new Set(webhookEventTypes()))
  })

  it('every accepted type is deliverable through the resolver', () => {
    const undeliverable = WEBHOOK_EVENTS.filter((t) => !webhookResolver.interestedIn(t))
    expect(undeliverable).toEqual([])
  })

  it('the admin picker lists every accepted type', () => {
    expect(new Set<string>(WEBHOOK_EVENT_CONFIG.map((c) => c.id))).toEqual(
      new Set<string>(WEBHOOK_EVENTS)
    )
  })
})
