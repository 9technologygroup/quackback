/**
 * Which principals the team controls today: their display names are the
 * team's, so tool results can show them without an untrusted marker.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createId, type PrincipalId } from '@quackback/ids'
import { createDbTestFixture, testDb } from '@/lib/server/__tests__/db-test-fixture'
import { principal } from '@/lib/server/db'

vi.mock('@/lib/server/db', async (original) => ({
  ...(await original<typeof import('@/lib/server/db')>()),
  db: (await import('@/lib/server/__tests__/db-test-fixture')).testDb,
}))

import { isOnTeam, principalIdsOnTeam } from '../principal-standing'

const fixture = await createDbTestFixture({
  probe: async (db) => void (await db.select({ id: principal.id }).from(principal).limit(0)),
})

describe('isOnTeam', () => {
  it('counts admins, members and service principals', () => {
    expect(isOnTeam({ type: 'user', role: 'admin' })).toBe(true)
    expect(isOnTeam({ type: 'user', role: 'member' })).toBe(true)
    expect(isOnTeam({ type: 'service', role: 'member' })).toBe(true)
    expect(isOnTeam({ type: 'user', role: 'user' })).toBe(false)
    expect(isOnTeam({ type: 'anonymous', role: 'user' })).toBe(false)
    expect(isOnTeam({ type: null, role: null })).toBe(false)
  })
})

describe.skipIf(!fixture.available)('principalIdsOnTeam (real DB)', () => {
  const ids = {
    admin: createId('principal') as PrincipalId,
    member: createId('principal') as PrincipalId,
    formerTeammate: createId('principal') as PrincipalId,
    integration: createId('principal') as PrincipalId,
    customer: createId('principal') as PrincipalId,
    visitor: createId('principal') as PrincipalId,
  }

  beforeEach(async () => {
    await fixture.begin()
    const now = new Date()
    await testDb.insert(principal).values([
      { id: ids.admin, role: 'admin', type: 'user', createdAt: now },
      { id: ids.member, role: 'member', type: 'user', createdAt: now },
      { id: ids.formerTeammate, role: 'user', type: 'user', createdAt: now },
      { id: ids.integration, role: 'member', type: 'service', createdAt: now },
      { id: ids.customer, role: 'user', type: 'user', createdAt: now },
      { id: ids.visitor, role: 'user', type: 'anonymous', createdAt: now },
    ])
  })
  afterEach(fixture.rollback)
  afterAll(fixture.close)

  it('returns the teammates and service principals among the ids', async () => {
    const onTeam = await principalIdsOnTeam([...Object.values(ids), null, undefined, ids.admin])
    expect([...onTeam].sort()).toEqual([ids.admin, ids.member, ids.integration].sort())
  })

  it('reads nothing for no ids', async () => {
    expect(await principalIdsOnTeam([null, undefined])).toEqual(new Set())
  })
})
