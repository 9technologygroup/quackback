/**
 * The per-minute recovery sweep runs only when a running sync's lease is about
 * to run out.
 *
 * Without the gate every workspace ran this job every minute, integration or
 * not. The gate reads the same rows recovery takes, so it can only suppress a
 * minute that would have recovered nothing.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createId } from '@quackback/ids'
import { createDbTestFixture, testDb } from '@/lib/server/__tests__/db-test-fixture'
vi.mock('@/lib/server/db', async (original) => ({
  ...(await original<typeof import('@/lib/server/db')>()),
  db: (await import('@/lib/server/__tests__/db-test-fixture')).testDb,
}))
vi.mock('@/lib/server/secret-key', () => ({
  activeSecretKey: () => 'integration-sync-test-key-32-characters-only',
}))
import {
  boards,
  posts,
  principal,
  integrations,
  integrationSyncOperations as operations,
  eq,
} from '@/lib/server/db'
import { queueHookSync } from '../hooks'
import { claimSyncOperation } from '../ledger'
import { isIntegrationSyncSweepDue, sweepIntegrationSync } from '../sweep-queue'
import type { HookJobData } from '@/lib/server/events/hook-job'

const fixture = await createDbTestFixture()
beforeEach(() => fixture.begin())
afterEach(() => fixture.rollback())
afterAll(fixture.close)

/** A sync claimed by a worker, whose lease runs out `leaseInMs` from now. */
async function runningSync(leaseInMs: number) {
  const [actor] = await testDb
    .insert(principal)
    .values({ type: 'service', role: 'user', createdAt: new Date() })
    .returning()
  const [board] = await testDb
    .insert(boards)
    .values({ name: 'Sweep gate', slug: `probe-${randomUUID()}` })
    .returning()
  const [post] = await testDb
    .insert(posts)
    .values({ boardId: board.id, principalId: actor.id, title: 'Probe', content: 'Body' })
    .returning()
  const [integration] = await testDb
    .insert(integrations)
    .values({ integrationType: 'linear', status: 'active', config: { channelId: 'team' } })
    .returning()
  const data: HookJobData = {
    hookType: 'linear',
    config: { integrationId: integration.id },
    target: { channelId: 'team' },
    event: {
      id: createId('event'),
      type: 'post.created',
      timestamp: new Date().toISOString(),
      actor: { type: 'service' },
      data: {
        post: {
          id: post.id,
          title: post.title,
          content: post.content,
          boardId: board.id,
          boardSlug: board.slug,
          voteCount: 0,
        },
      },
    },
  }
  const operation = (await queueHookSync(data))!
  await claimSyncOperation(operation.id)
  await testDb
    .update(operations)
    .set({ leaseExpiresAt: new Date(Date.now() + leaseInMs) })
    .where(eq(operations.id, operation.id))
  return operation.id
}

async function stateOf(id: string) {
  return (await testDb.query.integrationSyncOperations.findFirst({ where: eq(operations.id, id) }))
    ?.state
}

describe('the integration sync recovery gate (PostgreSQL)', () => {
  it('stays shut while no sync is running', async () => {
    expect(await isIntegrationSyncSweepDue()).toBe(false)
  })

  it('stays shut while every running lease has more than a minute left', async () => {
    const id = await runningSync(10 * 60_000)
    expect(await stateOf(id)).toBe('running')
    expect(await isIntegrationSyncSweepDue()).toBe(false)
  })

  it('opens for a lease that has run out, and the sweep it lets through recovers that sync', async () => {
    const id = await runningSync(-1_000)
    expect(await isIntegrationSyncSweepDue()).toBe(true)

    await sweepIntegrationSync()
    expect(await stateOf(id)).toBe('queued')
  })

  it('opens a minute ahead, so recovery is no later than the per-minute sweep it gates', async () => {
    await runningSync(30_000)
    expect(await isIntegrationSyncSweepDue()).toBe(true)
  })
})
