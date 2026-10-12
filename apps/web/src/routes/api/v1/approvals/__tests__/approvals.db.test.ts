/**
 * GET /api/v1/approvals and GET /api/v1/approvals/:approvalId against a real
 * database: a key follows the requests it filed (and what its creator may
 * decide), never another key's, with the repo's cursor pagination and a
 * status filter. Only the key lookup is stubbed; the route resolves the key's
 * creator and every row from Postgres.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createId, type PrincipalId } from '@quackback/ids'
import { createDbTestFixture, testDb } from '@/lib/server/__tests__/db-test-fixture'
import { principal, user, settings, apiKeys } from '@/lib/server/db'
import { ALL_PERMISSIONS } from '@/lib/shared/permissions'
import type { Actor } from '@/lib/server/policy/types'
import type { ApiKeyScope } from '@/lib/shared/api-key-scopes'

const mockWithApiKeyAuth = vi.fn()

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: vi.fn(() => (opts: unknown) => ({ options: opts })),
}))
vi.mock('@/lib/server/domains/api/auth', async (original) => ({
  ...(await original<typeof import('@/lib/server/domains/api/auth')>()),
  withApiKeyAuth: (...args: unknown[]) => mockWithApiKeyAuth(...args),
}))
vi.mock('@/lib/server/config-file/managed-guard', () => ({
  assertNotManaged: async () => undefined,
}))
vi.mock('@/lib/server/db', async (original) => ({
  ...(await original<typeof import('@/lib/server/db')>()),
  db: (await import('@/lib/server/__tests__/db-test-fixture')).testDb,
}))
vi.mock('@/lib/server/domains/settings/settings.helpers', async (original) => ({
  ...(await original<typeof import('@/lib/server/domains/settings/settings.helpers')>()),
  invalidateSettingsCache: async () => undefined,
}))
vi.mock('@/lib/server/config', async (original) => ({
  ...(await original<typeof import('@/lib/server/config')>()),
  getBaseUrl: () => 'https://acme.example.com',
}))

import { Route as ListRoute } from '../index'
import { Route as GetRoute } from '../$approvalId'
import {
  enqueueWorkspaceSettingsProposal,
  applyWorkspaceSettingsProposal,
  undoWorkspaceSettingsProposal,
} from '@/lib/server/domains/assistant/workspace-settings-actions.service'
import { rejectApproval } from '@/lib/server/domains/assistant/approvals.service'

type Handler = (args: { request: Request; params?: Record<string, string> }) => Promise<Response>
type RouteOpts = { server: { handlers: { GET: Handler } } }
const LIST = (ListRoute as unknown as { options: RouteOpts }).options.server.handlers.GET
const GET = (GetRoute as unknown as { options: RouteOpts }).options.server.handlers.GET

const fixture = await createDbTestFixture()

interface SeededKey {
  id: string
  principalId: PrincipalId
  createdById: PrincipalId
  scopes: ApiKeyScope[] | null
  creator: Actor
}

let owner: Actor
let otherAdmin: Actor

async function seedAdmin(): Promise<Actor> {
  const userId = createId('user')
  const principalId = createId('principal')
  await testDb.insert(user).values({ id: userId, name: 'Acme', email: `${userId}@example.com` })
  await testDb
    .insert(principal)
    .values({ id: principalId, userId, role: 'admin', type: 'user', createdAt: new Date() })
  return {
    principalId,
    role: 'admin',
    principalType: 'user',
    segmentIds: new Set(),
    permissions: new Set(ALL_PERMISSIONS),
  }
}

async function seedKey(
  creator: Actor,
  scopes: ApiKeyScope[] | null = ['read:settings', 'write:settings']
): Promise<SeededKey> {
  const principalId = createId('principal')
  await testDb.insert(principal).values({
    id: principalId,
    role: 'admin',
    type: 'service',
    displayName: 'Deploy bot',
    createdAt: new Date(),
  })
  const [row] = await testDb
    .insert(apiKeys)
    .values({
      name: 'Deploy bot',
      keyHash: createId('api_key').padEnd(64, '0').slice(0, 64),
      keyPrefix: 'qb_test',
      createdById: creator.principalId!,
      principalId,
      scopes: scopes === null ? null : JSON.stringify(scopes),
    })
    .returning()
  return { id: row!.id, principalId, createdById: creator.principalId!, scopes, creator }
}

/** Authenticate the next request as this key. */
function as(key: SeededKey) {
  mockWithApiKeyAuth.mockResolvedValue({
    apiKey: {
      id: key.id,
      name: 'Deploy bot',
      principalId: key.principalId,
      createdById: key.createdById,
      scopes: key.scopes,
    },
    principalId: key.principalId,
    role: 'admin',
    principal: null,
    importMode: false,
  })
}

async function fileThrough(key: SeededKey, displayName: string) {
  return enqueueWorkspaceSettingsProposal(
    key.creator,
    [{ area: 'portal', patch: { displayName } }],
    undefined,
    undefined,
    {
      via: 'mcp',
      requestedById: key.principalId,
      onBehalfOfPrincipalId: key.creator.principalId!,
      credentialId: key.id,
      clientName: 'Deploy bot',
    }
  )
}

const getOne = (approvalId: string) =>
  GET({
    request: new Request(`http://test/api/v1/approvals/${approvalId}`),
    params: { approvalId },
  })
const list = (query = '') => LIST({ request: new Request(`http://test/api/v1/approvals${query}`) })

type ListBody = {
  data: Array<{ id: string; status: string }>
  meta: { pagination: { cursor: string | null; hasMore: boolean } }
}

beforeEach(async () => {
  expect(fixture.available).toBe(true)
  await fixture.begin()
  mockWithApiKeyAuth.mockReset()
  owner = await seedAdmin()
  otherAdmin = await seedAdmin()
  await testDb.insert(settings).values({
    name: 'Acme',
    slug: `acme-${createId('workspace')}`,
    createdAt: new Date(),
    brandingConfig: '{}',
    widgetConfig: '{}',
    metadata: '{}',
    featureFlags: JSON.stringify({ copilotHome: true }),
    portalConfig: '{}',
  })
})
afterEach(() => fixture.rollback())
afterAll(() => fixture.close())

describe('GET /api/v1/approvals/:approvalId', () => {
  it('returns a request the key filed, with the page a person opens to decide it', async () => {
    const key = await seedKey(owner)
    const filed = await fileThrough(key, 'Acme team')
    as(key)

    const res = await getOne(filed.id)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Record<string, unknown> }
    expect(body.data).toMatchObject({
      id: filed.id,
      status: 'pending',
      risk: 'low',
      title: 'Settings change',
      summary: 'Change the workspace name',
      changes: [{ field: 'portal.displayName', from: 'Acme', to: 'Acme team' }],
      requestedVia: 'mcp',
      requestedById: key.principalId,
      onBehalfOfPrincipalId: owner.principalId,
      clientName: 'Deploy bot',
      decidedById: null,
      decidedVia: null,
      reason: null,
      undoneAt: null,
      url: `https://acme.example.com/admin/approvals?id=${filed.id}`,
    })
  })

  it('reads an applied change a person undid as undone, with when', async () => {
    const key = await seedKey(owner)
    const filed = await fileThrough(key, 'Acme team')
    await applyWorkspaceSettingsProposal(otherAdmin, filed.id, ['portal.displayName'], {
      contentHash: filed.argsDigest!,
    })
    as(key)
    const applied = (await (await getOne(filed.id)).json()) as { data: Record<string, unknown> }
    expect(applied.data).toMatchObject({ status: 'applied', undoneAt: null })

    await undoWorkspaceSettingsProposal(otherAdmin, filed.id)
    const res = await getOne(filed.id)
    expect(res.status).toBe(200)
    const undone = (await res.json()) as { data: Record<string, unknown> }
    expect(undone.data).toMatchObject({ status: 'undone', decidedById: otherAdmin.principalId })
    expect(new Date(undone.data.undoneAt as string).getTime()).toBeGreaterThan(0)

    const listed = (await (await list('?status=undone')).json()) as ListBody
    expect(listed.data.map((item) => [item.id, item.status])).toEqual([[filed.id, 'undone']])
    const stillApplied = (await (await list('?status=applied')).json()) as ListBody
    expect(stillApplied.data).toEqual([])
  })

  it("answers 404 for another key's request, exactly as for one that does not exist", async () => {
    const keyA = await seedKey(owner)
    // The second key's creator could decide it, but the key itself may only read.
    const keyB = await seedKey(otherAdmin, ['read:settings'])
    const filed = await fileThrough(keyA, 'Acme team')
    as(keyB)

    const hidden = await getOne(filed.id)
    const missing = await getOne(createId('assistant_action'))
    expect(hidden.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(await hidden.json()).toEqual(await missing.json())
  })

  it('rejects a malformed id', async () => {
    as(await seedKey(owner))
    expect((await getOne('not-an-id')).status).toBe(400)
  })

  it('needs the read:settings scope', async () => {
    const key = await seedKey(owner, ['read:feedback'])
    const filed = await fileThrough(key, 'Acme team')
    as(key)
    const res = await getOne(filed.id)
    expect(res.status).toBe(403)
    expect(JSON.stringify(await res.json())).not.toContain(filed.id)
  })
})

describe('GET /api/v1/approvals', () => {
  it('pages with the cursor and hasMore of every list endpoint', async () => {
    const key = await seedKey(owner)
    const ids: string[] = []
    for (const name of ['One', 'Two', 'Three']) ids.push((await fileThrough(key, name)).id)
    as(key)

    const first = (await (await list('?limit=2')).json()) as ListBody
    expect(first.data.map((item) => item.id)).toEqual([ids[2], ids[1]])
    expect(first.meta.pagination).toEqual({ cursor: ids[1], hasMore: true })

    const second = (await (
      await list(`?limit=2&cursor=${first.meta.pagination.cursor}`)
    ).json()) as ListBody
    expect(second.data.map((item) => item.id)).toEqual([ids[0]])
    expect(second.meta.pagination).toEqual({ cursor: null, hasMore: false })
  })

  it('filters by status', async () => {
    const key = await seedKey(owner)
    const kept = await fileThrough(key, 'Kept')
    const turnedDown = await fileThrough(key, 'Turned down')
    await rejectApproval(otherAdmin, turnedDown.id, { contentHash: turnedDown.argsDigest! })
    as(key)

    const rejected = (await (await list('?status=rejected')).json()) as ListBody
    expect(rejected.data.map((item) => [item.id, item.status])).toEqual([
      [turnedDown.id, 'rejected'],
    ])
    const pending = (await (await list('?status=pending')).json()) as ListBody
    expect(pending.data.map((item) => item.id)).toEqual([kept.id])
    expect((await list('?status=done')).status).toBe(400)
  })

  it("never lists another key's requests", async () => {
    const keyA = await seedKey(owner)
    const keyB = await seedKey(otherAdmin, ['read:settings'])
    await fileThrough(keyA, 'Acme team')
    as(keyB)
    const body = (await (await list()).json()) as ListBody
    expect(body.data).toEqual([])
    expect(body.meta.pagination).toEqual({ cursor: null, hasMore: false })
  })

  it('rejects a cursor that is not an approval id', async () => {
    as(await seedKey(owner))
    expect((await list('?cursor=garbage')).status).toBe(400)
  })
})
