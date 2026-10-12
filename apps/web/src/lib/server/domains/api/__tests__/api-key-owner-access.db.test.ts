/**
 * Real-Postgres coverage for an API key following its creator's current access.
 *
 * A key acts for the teammate who created it. Its authority on every request is
 * the key's own role preset intersected with the creator's CURRENT permission
 * set (custom roles included), so demoting, re-roling or removing the creator
 * takes effect on the very next request. The flows run end to end: keys come
 * from createApiKey, role changes go through updateMemberRole /
 * removeTeamMember / removePortalUser, and requests authenticate through
 * withApiKeyAuth against the live schema inside a rolled-back transaction.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { createId, type PrincipalId, type RoleId, type UserId } from '@quackback/ids'
import { createDbTestFixture, testDb } from '@/lib/server/__tests__/db-test-fixture'
import {
  apiKeys,
  eq,
  permissions,
  principal,
  principalRoleAssignments,
  rolePermissions,
  roles,
  user,
} from '@/lib/server/db'
import { ALL_PERMISSIONS, PERMISSIONS, type PermissionKey } from '@/lib/shared/permissions'
import { ForbiddenError, UnauthorizedError } from '@/lib/shared/errors'

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

const logs = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('@/lib/server/logger', () => {
  const stub: Record<string, unknown> = {
    warn: logs.warn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  }
  stub.child = () => stub
  return { logger: stub, createLogger: () => stub }
})

import { requireApiKey, withApiKeyAuth, assertApiPermissions } from '../auth'
import { serviceActorFromApiAuth } from '../service-actor'
import { createApiKey } from '@/lib/server/domains/api-keys/api-key.service'
import {
  removeTeamMember,
  updateMemberRole,
} from '@/lib/server/domains/principals/principal.service'
import { removePortalUser } from '@/lib/server/domains/users/user.service'

const statements: string[] = []
const fixture = await createDbTestFixture({
  logger: { logQuery: (query) => void statements.push(query) },
  probe: async (db) => {
    await db
      .select({ id: apiKeys.id, creator: apiKeys.createdById, scopes: apiKeys.scopes })
      .from(apiKeys)
      .limit(0)
    await db.select({ id: principal.id, blocked: principal.blockedAt }).from(principal).limit(0)
    await db.select({ id: principalRoleAssignments.id }).from(principalRoleAssignments).limit(0)
  },
})

const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

async function seedTeammate(role: 'admin' | 'member'): Promise<PrincipalId> {
  const userId = createId('user') as UserId
  const principalId = createId('principal') as PrincipalId
  await testDb
    .insert(user)
    .values({ id: userId, name: `Teammate ${role}`, email: `key-owner-${suffix()}@example.com` })
  await testDb
    .insert(principal)
    .values({ id: principalId, userId, role, type: 'user', createdAt: new Date() })
  return principalId
}

/** A custom role holding exactly `granted`. */
async function seedCustomRole(granted: PermissionKey[]): Promise<RoleId> {
  const roleId = createId('role') as RoleId
  await testDb.insert(roles).values({ id: roleId, key: roleId, name: 'Narrow', isSystem: false })
  for (const key of granted) {
    const [row] = await testDb
      .select({ id: permissions.id })
      .from(permissions)
      .where(eq(permissions.key, key))
      .limit(1)
    await testDb.insert(rolePermissions).values({ roleId, permissionId: row.id })
  }
  return roleId
}

function bearer(token: string): Request {
  return new Request('https://example.com/api/v1/posts', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  })
}

/** An admin creator, a second admin who manages them, and a key the creator made. */
async function seedAdminKey() {
  const creator = await seedTeammate('admin')
  const manager = await seedTeammate('admin')
  const { apiKey, plainTextKey } = await createApiKey({ name: 'Integration' }, creator)
  return { creator, manager, apiKey, token: plainTextKey }
}

if (fixture.available) {
  beforeEach(() => fixture.begin())
  afterEach(() => fixture.rollback())
  afterAll(() => fixture.close())
}

describe.skipIf(!fixture.available)('API key authority follows its creator (real Postgres)', () => {
  beforeEach(() => {
    logs.warn.mockClear()
    statements.length = 0
  })

  it('carries full admin authority while the creator is an admin', async () => {
    const { token } = await seedAdminKey()

    const auth = await withApiKeyAuth(bearer(token), { permission: PERMISSIONS.MEMBER_MANAGE })

    expect(auth.role).toBe('admin')
    expect(auth.permissions.has(PERMISSIONS.BILLING_MANAGE)).toBe(true)
    expect(auth.permissions.has(PERMISSIONS.POST_CREATE)).toBe(true)
  })

  it('drops admin-only access once the creator is demoted to member', async () => {
    const { creator, manager, token } = await seedAdminKey()

    await updateMemberRole(creator, 'member', manager, null, undefined, { granterRole: 'admin' })

    await expect(
      withApiKeyAuth(bearer(token), { permission: PERMISSIONS.MEMBER_MANAGE })
    ).rejects.toThrow(ForbiddenError)
    await expect(
      withApiKeyAuth(bearer(token), { permission: PERMISSIONS.MEMBER_MANAGE })
    ).rejects.toThrow("Requires the 'member.manage' permission")

    const auth = await withApiKeyAuth(bearer(token), { permission: PERMISSIONS.POST_CREATE })
    expect(auth.role).toBe('member')
    expect(() => assertApiPermissions(auth, [PERMISSIONS.SETTINGS_MANAGE])).toThrow(ForbiddenError)
    expect(() => assertApiPermissions(auth, [PERMISSIONS.POST_EDIT])).not.toThrow()
    expect(serviceActorFromApiAuth(auth).permissions?.has(PERMISSIONS.MEMBER_MANAGE)).toBe(false)
  })

  it('refuses the key like an unknown key once the creator is removed from the team', async () => {
    const { creator, manager, token } = await seedAdminKey()

    await removeTeamMember(creator, manager, null, undefined, { granterRole: 'admin' })

    expect(await requireApiKey(bearer(token))).toBeNull()
    await expect(withApiKeyAuth(bearer(token))).rejects.toThrow(UnauthorizedError)
    await expect(
      withApiKeyAuth(bearer(token), { permission: PERMISSIONS.POST_CREATE })
    ).rejects.toThrow('Invalid or missing API key')
  })

  it('keeps refusing the key after the removed creator is deleted outright', async () => {
    const { creator, manager, token, apiKey } = await seedAdminKey()

    await removeTeamMember(creator, manager, null, undefined, { granterRole: 'admin' })
    await removePortalUser(creator)

    await expect(withApiKeyAuth(bearer(token))).rejects.toThrow(UnauthorizedError)
    const [row] = await testDb.select().from(apiKeys).where(eq(apiKeys.id, apiKey.id))
    expect(row.revokedAt).not.toBeNull()
    const [service] = await testDb
      .select({ role: principal.role })
      .from(principal)
      .where(eq(principal.id, apiKey.principalId))
    expect(service.role).toBe('user')
  })

  it('refuses a permission missing from the creator custom role even when the key preset has it', async () => {
    const { creator, manager, token } = await seedAdminKey()
    const narrow = await seedCustomRole([PERMISSIONS.POST_VIEW_PRIVATE])
    await updateMemberRole(creator, 'member', manager, null, undefined, {
      assignRoleId: narrow,
      granterPermissions: ALL_PERMISSIONS,
      granterRole: 'admin',
    })

    await expect(
      withApiKeyAuth(bearer(token), { permission: PERMISSIONS.POST_CREATE })
    ).rejects.toThrow("Requires the 'post.create' permission")

    const auth = await withApiKeyAuth(bearer(token), { permission: PERMISSIONS.POST_VIEW_PRIVATE })
    expect([...auth.permissions]).toEqual([PERMISSIONS.POST_VIEW_PRIVATE])
    expect(serviceActorFromApiAuth(auth).permissions?.has(PERMISSIONS.CONVERSATION_VIEW)).toBe(
      false
    )
  })

  it('caps a member-made key at the member preset after its creator is promoted', async () => {
    const creator = await seedTeammate('member')
    const manager = await seedTeammate('admin')
    const { plainTextKey } = await createApiKey({ name: 'Member key' }, creator)

    await updateMemberRole(creator, 'admin', manager, null, undefined, { granterRole: 'admin' })

    const auth = await withApiKeyAuth(bearer(plainTextKey))
    expect(auth.role).toBe('member')
    expect(auth.permissions.has(PERMISSIONS.MEMBER_MANAGE)).toBe(false)
  })

  it('keeps scopes narrowing the creator authority', async () => {
    const creator = await seedTeammate('admin')
    const { plainTextKey } = await createApiKey(
      { name: 'Read only', scopes: ['read:feedback'] },
      creator
    )

    await expect(
      withApiKeyAuth(bearer(plainTextKey), { permission: PERMISSIONS.POST_CREATE })
    ).rejects.toThrow("'write:feedback' scope")
    const auth = await withApiKeyAuth(bearer(plainTextKey), {
      permission: PERMISSIONS.POST_VIEW_PRIVATE,
    })
    expect(auth.role).toBe('admin')
  })

  it('refuses a key with no recorded creator like an unknown key and warns once per key', async () => {
    const { token, apiKey } = await seedAdminKey()
    // Deleting the creator's principal clears created_by_id (ON DELETE SET NULL).
    await testDb.update(apiKeys).set({ createdById: null }).where(eq(apiKeys.id, apiKey.id))

    expect(await requireApiKey(bearer(token))).toBeNull()
    await expect(withApiKeyAuth(bearer(token))).rejects.toThrow(UnauthorizedError)
    await expect(
      withApiKeyAuth(bearer(token), { permission: PERMISSIONS.POST_CREATE })
    ).rejects.toThrow('Invalid or missing API key')

    const warnings = logs.warn.mock.calls.filter(
      ([fields]) => (fields as { api_key_id?: string })?.api_key_id === apiKey.id
    )
    expect(warnings).toHaveLength(1)
    expect(JSON.stringify(warnings)).not.toContain(token)
    expect(JSON.stringify(warnings)).not.toContain(apiKey.keyPrefix)
  })

  it('resolves the key, its principal and creator, and the creator grants in three reads', async () => {
    const { token } = await seedAdminKey()
    statements.length = 0

    await withApiKeyAuth(bearer(token), { permission: PERMISSIONS.POST_CREATE })

    const reads = statements.filter((query) => /^\s*select/i.test(query))
    expect(reads).toHaveLength(3)
  })
})
