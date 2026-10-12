/**
 * Real-Postgres coverage for a person's API keys ending with their team
 * membership. Leaving the team by any path (removal, leaving, a role sync
 * that drops them to a portal user) revokes every live key they created in
 * the same transaction as the role change, so re-adding them later never
 * revives an old key. Moving between team roles keeps the keys, capped at the
 * lower role.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { createId, type PrincipalId, type UserId } from '@quackback/ids'
import { createDbTestFixture, testDb } from '@/lib/server/__tests__/db-test-fixture'
import { account, apiKeys, eq, principal, settings, user } from '@/lib/server/db'
import { PERMISSIONS } from '@/lib/shared/permissions'
import { ForbiddenError, UnauthorizedError } from '@/lib/shared/errors'
import type { ApiKey } from '@/lib/server/domains/api-keys'

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

vi.mock('@/lib/server/domains/api/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 100 })),
  getClientIp: vi.fn(() => '127.0.0.1'),
}))

import { withApiKeyAuth } from '@/lib/server/domains/api/auth'
import { createApiKey } from '../api-key.service'
import {
  leaveTeamSelf,
  removeTeamMember,
  updateMemberRole,
} from '@/lib/server/domains/principals/principal.service'
import { setPrincipalRole } from '@/lib/server/domains/principals/principal.factory'

const fixture = await createDbTestFixture({
  probe: async (db) => {
    await db.select({ id: apiKeys.id, revoked: apiKeys.revokedAt }).from(apiKeys).limit(0)
    await db.select({ id: account.id }).from(account).limit(0)
  },
})

const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** A teammate who has signed in, so they can be added back to the team later. */
async function seedTeammate(role: 'admin' | 'member') {
  const userId = createId('user') as UserId
  const principalId = createId('principal') as PrincipalId
  await testDb
    .insert(user)
    .values({ id: userId, name: `Teammate ${role}`, email: `departure-${suffix()}@example.com` })
  await testDb
    .insert(principal)
    .values({ id: principalId, userId, role, type: 'user', createdAt: new Date() })
  await testDb
    .insert(account)
    .values({ accountId: `sub-${suffix()}`, providerId: 'oidc', userId, updatedAt: new Date() })
  return { userId, principalId }
}

async function seedAdminKey() {
  const creator = await seedTeammate('admin')
  const manager = await seedTeammate('admin')
  const { apiKey, plainTextKey } = await createApiKey({ name: 'Integration' }, creator.principalId)
  return { creator, manager, apiKey, token: plainTextKey }
}

function bearer(token: string): Request {
  return new Request('https://example.com/api/v1/posts', {
    headers: { Authorization: `Bearer ${token}` },
  })
}

async function keyRow(apiKey: ApiKey) {
  const [row] = await testDb.select().from(apiKeys).where(eq(apiKeys.id, apiKey.id))
  const [service] = await testDb
    .select({ role: principal.role })
    .from(principal)
    .where(eq(principal.id, apiKey.principalId))
  return { revokedAt: row.revokedAt, serviceRole: service.role }
}

async function readd(principalId: PrincipalId, manager: PrincipalId) {
  await updateMemberRole(principalId, 'member', manager, null, undefined, { granterRole: 'admin' })
}

/** Adding someone to the team reads the workspace settings row; make sure one exists. */
async function ensureWorkspace() {
  const [existing] = await testDb.select({ id: settings.id }).from(settings).limit(1)
  if (existing) return
  await testDb.insert(settings).values({
    id: createId('workspace'),
    name: 'Acme',
    slug: `acme-${suffix()}`,
    createdAt: new Date(),
  })
}

if (fixture.available) {
  beforeEach(async () => {
    await fixture.begin()
    await ensureWorkspace()
  })
  afterEach(() => fixture.rollback())
  afterAll(() => fixture.close())
}

describe.skipIf(!fixture.available)('API keys end with team membership (real Postgres)', () => {
  it('revokes the keys of a removed teammate, and re-adding them does not revive any', async () => {
    const { creator, manager, apiKey, token } = await seedAdminKey()

    await removeTeamMember(creator.principalId, manager.principalId, null, undefined, {
      granterRole: 'admin',
    })
    expect(await keyRow(apiKey)).toMatchObject({ serviceRole: 'user' })
    expect((await keyRow(apiKey)).revokedAt).not.toBeNull()

    await readd(creator.principalId, manager.principalId)
    await expect(withApiKeyAuth(bearer(token))).rejects.toThrow(UnauthorizedError)
  })

  it('revokes the keys of a teammate who leaves, and re-adding them does not revive any', async () => {
    const { creator, manager, apiKey, token } = await seedAdminKey()

    await leaveTeamSelf(creator.principalId)
    expect((await keyRow(apiKey)).revokedAt).not.toBeNull()

    await readd(creator.principalId, manager.principalId)
    await expect(withApiKeyAuth(bearer(token))).rejects.toThrow(UnauthorizedError)
  })

  it('revokes the keys whenever the role writer moves someone off the team', async () => {
    const { creator, apiKey, token } = await seedAdminKey()

    // The path an identity-provider role sync takes when it drops a person to a portal user.
    await setPrincipalRole({ userId: creator.userId }, 'user')

    expect((await keyRow(apiKey)).revokedAt).not.toBeNull()
    await expect(withApiKeyAuth(bearer(token))).rejects.toThrow(UnauthorizedError)
  })

  it('revokes keys a former teammate still holds when they rejoin the team', async () => {
    const { creator, manager, apiKey, token } = await seedAdminKey()
    // A departure recorded before keys were revoked on leaving: the role moved, the key did not.
    await testDb
      .update(principal)
      .set({ role: 'user' })
      .where(eq(principal.id, creator.principalId))

    await readd(creator.principalId, manager.principalId)

    expect((await keyRow(apiKey)).revokedAt).not.toBeNull()
    await expect(withApiKeyAuth(bearer(token))).rejects.toThrow(UnauthorizedError)
  })

  it('keeps the keys of a teammate demoted between team roles, at the lower cap', async () => {
    const { creator, manager, apiKey, token } = await seedAdminKey()

    await updateMemberRole(creator.principalId, 'member', manager.principalId, null, undefined, {
      granterRole: 'admin',
    })

    expect(await keyRow(apiKey)).toEqual({ revokedAt: null, serviceRole: 'admin' })
    const auth = await withApiKeyAuth(bearer(token), { permission: PERMISSIONS.POST_CREATE })
    expect(auth.role).toBe('member')
    await expect(
      withApiKeyAuth(bearer(token), { permission: PERMISSIONS.MEMBER_MANAGE })
    ).rejects.toThrow(ForbiddenError)
  })
})
