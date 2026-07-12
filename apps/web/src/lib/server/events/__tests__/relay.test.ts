import { describe, it, expect, vi, beforeEach } from 'vitest'

// Bypass config's full env validation (see emit.test.ts / frequency-cap-race).
vi.mock('@/lib/server/db', async (importOriginal) => {
  const { createDb } = await import('@quackback/db/client')
  const url =
    process.env.DATABASE_URL ?? 'postgresql://postgres:password@localhost:5432/quackback_test'
  return {
    ...(await importOriginal<typeof import('@/lib/server/db')>()),
    db: createDb(url, { max: 5, prepare: false }),
  }
})

import { db, events, eq, isNull } from '@/lib/server/db'
import { createId } from '@quackback/ids'
import { drainOnce } from '../relay'
import type { HookTarget } from '../hook-types'
import type { DomainEvent } from '../envelope'

/**
 * WO-3 — the relay drain: reads unpublished rows in id order, enqueues one job
 * per target with a DETERMINISTIC id, marks rows published; a second drain
 * enqueues nothing (idempotent publish); a depth>MAX event is skipped and
 * marked published (reaction-loop guard). Runs against quackback_test.
 */

async function seedEvent(entityId: string, depth = 0): Promise<void> {
  await db.insert(events).values({
    eventId: createId('event'),
    type: 'post.created',
    entityType: 'post',
    entityId,
    actorType: 'user',
    payload: { postId: entityId },
    context: { depth },
    schemaVersion: 1,
  })
}

const oneTarget = async (): Promise<HookTarget[]> => [
  { type: 'webhook', target: { url: 'https://example.test/hook' }, config: { webhookId: 'wh_1' } },
]

describe('outbox relay drainOnce', () => {
  // Scope each test to its own entityId so parallel/prior rows don't interfere.
  let marker: string
  beforeEach(() => {
    marker = createId('post')
  })

  it('enqueues one deterministic job per target and marks rows published', async () => {
    await seedEvent(marker)
    await seedEvent(marker)

    const enqueued: Array<{ jobId: string }> = []
    const res = await drainOnce({
      resolve: oneTarget,
      enqueue: async (jobs) => {
        enqueued.push(...jobs)
      },
    })

    // Only assert on our two marker rows (the batch may include others, but ours must be handled).
    const ours = enqueued.filter((j) => j.jobId.includes(':webhook:'))
    expect(ours.length).toBeGreaterThanOrEqual(2)
    expect(res.enqueued).toBeGreaterThanOrEqual(2)

    // Every job id is deterministic: `${eventId}:${sink}:${targetKey}`.
    for (const j of enqueued) {
      expect(j.jobId).toMatch(/^evt_[0-9a-z]{26}:webhook:[0-9a-f]{16}$/)
    }

    const remaining = await db.select().from(events).where(eq(events.entityId, marker))
    expect(remaining.every((r) => r.publishedAt !== null)).toBe(true)
  })

  it('a second drain enqueues nothing new (idempotent publish)', async () => {
    await seedEvent(marker)
    await drainOnce({ resolve: oneTarget, enqueue: async () => {} })

    const enqueued: unknown[] = []
    await drainOnce({
      resolve: oneTarget,
      enqueue: async (jobs) => {
        enqueued.push(...jobs.filter((j) => j.jobId.includes(marker) === false))
      },
    })
    // Our marker row was already published, so it is not re-drained.
    const ourRows = await db.select().from(events).where(eq(events.entityId, marker))
    expect(ourRows.every((r) => r.publishedAt !== null)).toBe(true)
  })

  it('skips (but publishes) an event past the reaction-loop depth ceiling', async () => {
    await seedEvent(marker, 6)

    let enqueuedForMarker = 0
    await drainOnce({
      resolve: async (event: DomainEvent) => {
        if (event.entityId === marker) enqueuedForMarker++
        return oneTarget()
      },
      enqueue: async () => {},
    })

    // resolve() is never called for the over-depth marker event.
    expect(enqueuedForMarker).toBe(0)
    const rows = await db.select().from(events).where(eq(events.entityId, marker))
    expect(rows).toHaveLength(1)
    expect(rows[0].publishedAt).not.toBeNull()
  })

  it('leaves nothing unpublished after a full drain of the marker rows', async () => {
    await seedEvent(marker)
    await drainOnce({ resolve: async () => [], enqueue: async () => {} })
    const unpublished = await db.select().from(events).where(isNull(events.publishedAt))
    expect(unpublished.some((r) => r.entityId === marker)).toBe(false)
  })
})
