/**
 * Real-Postgres coverage for the import-mode rate limit.
 *
 * `x-import-mode: true` raises the per-minute cap for bulk imports. The raise
 * must belong to a verified admin key, never to the header alone: a caller
 * with no key, a bad key or a non-admin key stays at the base cap, and failed
 * key attempts never get more than the base cap. The real limiter runs against
 * the rate_bucket table inside a rolled-back transaction, with the tier's base
 * cap lowered to 2 so a few requests cross it.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { createId, type PrincipalId, type UserId } from '@quackback/ids'
import { createDbTestFixture, testDb } from '@/lib/server/__tests__/db-test-fixture'
import { apiKeys, principal, sql, user } from '@/lib/server/db'
import { RateLimitError, UnauthorizedError } from '@/lib/shared/errors'
import { OSS_TIER_LIMITS } from '@/lib/server/domains/settings/tier-limits.types'

vi.mock('@/lib/server/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/db')>()),
  db: (await import('@/lib/server/__tests__/db-test-fixture')).testDb,
}))

vi.mock('@/lib/server/cache', () => ({
  cacheDel: vi.fn(),
  CACHE_KEYS: { PRINCIPAL_BY_USER: (id: string) => `principal:user:${id}` },
}))

vi.mock('@/lib/server/domains/teams', () => ({
  addPrincipalToDefaultTeam: vi.fn(),
}))

vi.mock('@/lib/server/domains/principals/membership-sync', () => ({
  enqueueMembershipSync: vi.fn(async () => {}),
}))

const BASE_CAP = 2
vi.mock('@/lib/server/domains/settings/tier-limits.service', () => ({
  getTierLimits: vi.fn(async () => ({ ...OSS_TIER_LIMITS, apiRequestsPerMinute: BASE_CAP })),
}))

import { withApiKeyAuth } from '../auth'
import { createApiKey } from '@/lib/server/domains/api-keys/api-key.service'
import { updateMemberRole } from '@/lib/server/domains/principals/principal.service'

const fixture = await createDbTestFixture({
  probe: async (db) => {
    await db.execute(sql`select workspace_key, key, count from rate_bucket limit 0`)
    await db.select({ id: apiKeys.id, creator: apiKeys.createdById }).from(apiKeys).limit(0)
  },
})

const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

async function seedTeammate(role: 'admin' | 'member'): Promise<PrincipalId> {
  const userId = createId('user') as UserId
  const principalId = createId('principal') as PrincipalId
  await testDb
    .insert(user)
    .values({ id: userId, name: `Importer ${role}`, email: `import-${suffix()}@example.com` })
  await testDb
    .insert(principal)
    .values({ id: principalId, userId, role, type: 'user', createdAt: new Date() })
  return principalId
}

async function keyFor(role: 'admin' | 'member'): Promise<string> {
  const creator = await seedTeammate(role)
  const { plainTextKey } = await createApiKey({ name: `${role} importer` }, creator)
  return plainTextKey
}

function call(token: string, importMode = true): Request {
  return new Request('https://example.com/api/v1/posts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(importMode ? { 'x-import-mode': 'true' } : {}),
    },
  })
}

const UNKNOWN_KEY = `qb_${'0'.repeat(48)}`

if (fixture.available) {
  beforeEach(() => fixture.begin())
  afterEach(() => fixture.rollback())
  afterAll(() => fixture.close())
}

describe.skipIf(!fixture.available)('import-mode rate limit (real Postgres)', () => {
  beforeEach(async () => {
    // The limiter keys buckets by client address, which is "unknown" outside a
    // request context; start each test from an empty window.
    await testDb.execute(sql`delete from rate_bucket where key like 'api:rl:%'`)
  })

  it('gives an admin key asking for import mode the elevated cap', async () => {
    const token = await keyFor('admin')

    for (let i = 0; i < BASE_CAP + 3; i++) {
      const auth = await withApiKeyAuth(call(token))
      expect(auth.importMode).toBe(true)
    }
  })

  it('keeps a non-admin key asking for import mode at the base cap', async () => {
    const token = await keyFor('member')

    for (let i = 0; i < BASE_CAP; i++) {
      const auth = await withApiKeyAuth(call(token))
      expect(auth.importMode).toBe(false)
    }
    await expect(withApiKeyAuth(call(token))).rejects.toThrow(RateLimitError)
  })

  it('keeps an unauthenticated request asking for import mode at the base cap', async () => {
    for (let i = 0; i < BASE_CAP; i++) {
      await expect(withApiKeyAuth(call(UNKNOWN_KEY))).rejects.toThrow(UnauthorizedError)
    }
    await expect(withApiKeyAuth(call(UNKNOWN_KEY))).rejects.toThrow(RateLimitError)
  })

  it('gives no import allowance to an address that presented a bad key this window', async () => {
    const token = await keyFor('admin')

    await expect(withApiKeyAuth(call(UNKNOWN_KEY))).rejects.toThrow(UnauthorizedError)
    await withApiKeyAuth(call(token))
    await expect(withApiKeyAuth(call(token))).rejects.toThrow(RateLimitError)
  })

  it('drops the elevated cap once the key creator is no longer an admin', async () => {
    const creator = await seedTeammate('admin')
    const manager = await seedTeammate('admin')
    const { plainTextKey } = await createApiKey({ name: 'Importer' }, creator)
    await updateMemberRole(creator, 'member', manager, null, undefined, { granterRole: 'admin' })

    for (let i = 0; i < BASE_CAP; i++) await withApiKeyAuth(call(plainTextKey))
    await expect(withApiKeyAuth(call(plainTextKey))).rejects.toThrow(RateLimitError)
  })

  it('keeps an admin key at the base cap when it does not ask for import mode', async () => {
    const token = await keyFor('admin')

    for (let i = 0; i < BASE_CAP; i++) {
      expect((await withApiKeyAuth(call(token, false))).importMode).toBe(false)
    }
    await expect(withApiKeyAuth(call(token, false))).rejects.toThrow(RateLimitError)
  })
})
