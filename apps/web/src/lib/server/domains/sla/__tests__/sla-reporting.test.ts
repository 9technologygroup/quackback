/**
 * Real-DB coverage for SLA attainment reporting (§7): met/breached counts + the
 * attainment rate per clock, scoped to a date range. Fixture rollback.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { createId, type PrincipalId, type UserId, type ConversationId } from '@quackback/ids'

import { createDbTestFixture, testDb } from '@/lib/server/__tests__/db-test-fixture'
import { conversations, slaEvents, slaPolicies, user, principal } from '@/lib/server/db'

vi.mock('@/lib/server/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/db')>()),
  db: (await import('@/lib/server/__tests__/db-test-fixture')).testDb,
}))

import { slaAttainment } from '../sla-reporting'

const fixture = await createDbTestFixture({
  probe: async (db) => {
    await db.select({ id: slaEvents.id }).from(slaEvents).limit(0)
  },
})

const suffix = () => `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

async function seedConversationAndPolicy(): Promise<{
  conversationId: ConversationId
  policyId: string
}> {
  const userId = createId('user') as UserId
  const principalId = createId('principal') as PrincipalId
  await testDb.insert(user).values({ id: userId, name: `V-${suffix()}` })
  await testDb
    .insert(principal)
    .values({ id: principalId, userId, role: 'member', type: 'user', createdAt: new Date() })
  const [conv] = await testDb
    .insert(conversations)
    .values({ visitorPrincipalId: principalId, channel: 'messenger' })
    .returning()
  const [policy] = await testDb
    .insert(slaPolicies)
    .values({ name: `P-${suffix()}` })
    .returning()
  return { conversationId: conv.id, policyId: policy.id }
}

describe.skipIf(!fixture.available)('slaAttainment (real DB, rolled back)', () => {
  beforeEach(fixture.begin)
  afterEach(fixture.rollback)
  afterAll(fixture.close)

  it('counts met/breached per clock and computes the rate, scoped to the range', async () => {
    const { conversationId, policyId } = await seedConversationAndPolicy()
    const at = (iso: string) => new Date(iso)
    const ev = (kind: string, iso: string) => ({
      conversationId,
      policyId: policyId as never,
      kind,
      at: at(iso),
    })
    await testDb.insert(slaEvents).values([
      ev('first_response_met', '2026-01-05T10:00:00Z'),
      ev('first_response_met', '2026-01-05T11:00:00Z'),
      ev('first_response_met', '2026-01-05T12:00:00Z'),
      ev('first_response_breached', '2026-01-05T13:00:00Z'),
      ev('resolution_met', '2026-01-05T14:00:00Z'),
      ev('resolution_breached', '2026-01-05T15:00:00Z'),
      // Outside the range — must not count.
      ev('first_response_breached', '2026-02-01T10:00:00Z'),
    ])

    const res = await slaAttainment(at('2026-01-01T00:00:00Z'), at('2026-02-01T00:00:00Z'))
    expect(res.firstResponse).toEqual({ met: 3, breached: 1, rate: 0.75 })
    expect(res.resolution).toEqual({ met: 1, breached: 1, rate: 0.5 })
  })

  it('reports a null rate for a clock with no events', async () => {
    const res = await slaAttainment(
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-01-02T00:00:00Z')
    )
    expect(res.firstResponse).toEqual({ met: 0, breached: 0, rate: null })
    expect(res.resolution).toEqual({ met: 0, breached: 0, rate: null })
  })
})
