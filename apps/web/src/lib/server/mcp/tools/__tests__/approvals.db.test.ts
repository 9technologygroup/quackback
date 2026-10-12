/**
 * The MCP approval reads against a real database: an assistant files a
 * settings request, is told where a person decides it, and follows it with
 * get_approval and list_approvals. Another key reads nothing of it.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { createId, type PrincipalId } from '@quackback/ids'
import { createDbTestFixture, testDb } from '@/lib/server/__tests__/db-test-fixture'
import { eq, principal, user, settings, apiKeys, assistantPendingActions } from '@/lib/server/db'
import { ALL_PERMISSIONS } from '@/lib/shared/permissions'
import type { Actor } from '@/lib/server/policy/types'
import type { ApiKeyScope } from '@/lib/shared/api-key-scopes'

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
vi.mock('@/lib/server/domains/settings/settings.service', async (original) => ({
  ...(await original<typeof import('@/lib/server/domains/settings/settings.service')>()),
  isFeatureEnabled: async () => true,
}))
vi.mock('@/lib/server/config', async (original) => ({
  ...(await original<typeof import('@/lib/server/config')>()),
  getBaseUrl: () => 'https://acme.example.com',
}))

import { registerSettingsTools } from '../settings'
import { registerApprovalTools } from '../approvals'
import { rejectApproval } from '@/lib/server/domains/assistant/approvals.service'
import {
  applyWorkspaceSettingsProposal,
  undoWorkspaceSettingsProposal,
} from '@/lib/server/domains/assistant/workspace-settings-actions.service'
import type { McpAuthContext } from '../../types'

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>

const fixture = await createDbTestFixture()

type Person = Actor & { userId: string }

let owner: Person
let otherAdmin: Person

async function seedPerson(role: 'admin' | 'member'): Promise<Person> {
  const userId = createId('user')
  const principalId = createId('principal')
  await testDb.insert(user).values({ id: userId, name: 'Acme', email: `${userId}@example.com` })
  await testDb
    .insert(principal)
    .values({ id: principalId, userId, role, type: 'user', createdAt: new Date() })
  return {
    userId,
    principalId,
    role,
    principalType: 'user',
    segmentIds: new Set(),
    ...(role === 'admin' ? { permissions: new Set(ALL_PERMISSIONS) } : {}),
  }
}

const seedAdmin = () => seedPerson('admin')

/** The tools a session registers. */
function session(auth: McpAuthContext): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  const server = {
    tool: (name: string, _d: string, _s: unknown, _a: unknown, handler: Handler) => {
      handlers.set(name, handler)
    },
  }
  registerSettingsTools(server as never, auth)
  registerApprovalTools(server as never, auth)
  return handlers
}

/** A person signed in through a shared assistant client, the way the handler resolves one. */
function oauthSession(person: Person, scopes: ApiKeyScope[]): Map<string, Handler> {
  return session({
    principalId: person.principalId!,
    userId: person.userId as never,
    name: 'Acme',
    role: person.role as 'admin' | 'member',
    authMethod: 'oauth',
    credentialId: 'oauth-client-1',
    scopes,
  })
}

/** A key's MCP session, the way the handler resolves one. */
async function keySession(
  creator: Actor,
  scopes: ApiKeyScope[] = ['read:settings', 'write:settings'],
  keyRole: 'admin' | 'member' = 'admin'
): Promise<Map<string, Handler>> {
  const principalId = createId('principal') as PrincipalId
  await testDb.insert(principal).values({
    id: principalId,
    role: keyRole,
    type: 'service',
    displayName: 'Deploy bot',
    createdAt: new Date(),
  })
  const [key] = await testDb
    .insert(apiKeys)
    .values({
      name: 'Deploy bot',
      keyHash: createId('api_key').padEnd(64, '0').slice(0, 64),
      keyPrefix: 'qb_test',
      createdById: creator.principalId!,
      principalId,
      scopes: JSON.stringify(scopes),
    })
    .returning()
  const auth: McpAuthContext = {
    principalId,
    name: 'Deploy bot',
    role: keyRole,
    authMethod: 'api-key',
    credentialId: key!.id,
    clientName: 'Deploy bot',
    scopes,
  }
  return session(auth)
}

const text = (result: CallToolResult) => (result.content[0] as { text: string }).text
const json = (result: CallToolResult) => {
  expect(result.isError, text(result)).not.toBe(true)
  return JSON.parse(text(result)) as Record<string, unknown>
}

async function propose(tools: Map<string, Handler>, displayName: string) {
  return json(
    await tools.get('propose_settings_change')!({
      changes: [{ area: 'portal', patch: { displayName } }],
    })
  )
}

beforeEach(async () => {
  expect(fixture.available).toBe(true)
  await fixture.begin()
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

describe('propose_settings_change', () => {
  it('returns the approval id and the page a person decides it on, and points to get_approval', async () => {
    const tools = await keySession(owner)
    const filed = await propose(tools, 'Acme team')
    expect(filed.approvalId).toMatch(/^assistant_action_/)
    expect(filed.url).toBe(`https://acme.example.com/admin/approvals?id=${filed.approvalId}`)
    expect(filed.status).toBe('pending')
    expect(String(filed.next)).toContain('get_approval')
  })
})

describe('get_approval', () => {
  it('reads by id or by url, with the same fields the REST API returns', async () => {
    const tools = await keySession(owner)
    const filed = await propose(tools, 'Acme team')

    const byId = json(await tools.get('get_approval')!({ approval: filed.approvalId }))
    expect(byId).toEqual({
      id: filed.approvalId,
      status: 'pending',
      risk: 'low',
      toolName: 'propose_settings_change',
      title: 'Settings change',
      summary: 'Change the workspace name',
      changes: [{ field: 'portal.displayName', from: 'Acme', to: 'Acme team' }],
      conversationId: null,
      ticketId: null,
      requestedVia: 'mcp',
      requestedById: expect.stringMatching(/^principal_/),
      onBehalfOfPrincipalId: owner.principalId,
      clientName: 'Deploy bot',
      createdAt: expect.any(String),
      expiresAt: expect.any(String),
      decidedById: null,
      decidedAt: null,
      decidedVia: null,
      reason: null,
      undoneAt: null,
      url: filed.url,
      untrusted: { note: expect.any(String), fields: ['clientName'] },
    })
    const byUrl = json(await tools.get('get_approval')!({ approval: filed.url }))
    expect(byUrl).toEqual(byId)
  })

  it('follows the request to its decision', async () => {
    const tools = await keySession(owner)
    const filed = await propose(tools, 'Acme team')
    const { getPendingActionById } =
      await import('@/lib/server/domains/assistant/pending-actions.service')
    const row = await getPendingActionById(filed.approvalId as never)
    await rejectApproval(otherAdmin, row!.id, {
      contentHash: row!.argsDigest!,
      reason: 'Keep the current name',
    })
    expect(json(await tools.get('get_approval')!({ approval: filed.approvalId }))).toMatchObject({
      status: 'rejected',
      decidedById: otherAdmin.principalId,
      decidedVia: 'app',
      reason: 'Keep the current name',
    })
  })

  it('reads an applied change a person undid as undone, with when', async () => {
    const tools = await keySession(owner)
    const filed = await propose(tools, 'Acme team')
    const { getPendingActionById } =
      await import('@/lib/server/domains/assistant/pending-actions.service')
    const row = await getPendingActionById(filed.approvalId as never)
    await applyWorkspaceSettingsProposal(otherAdmin, row!.id, ['portal.displayName'], {
      contentHash: row!.argsDigest!,
    })
    const applied = json(await tools.get('get_approval')!({ approval: filed.approvalId }))
    expect(applied).toMatchObject({ status: 'applied', undoneAt: null })

    await undoWorkspaceSettingsProposal(otherAdmin, row!.id)
    const undone = json(await tools.get('get_approval')!({ approval: filed.approvalId }))
    expect(undone).toMatchObject({ status: 'undone', decidedById: otherAdmin.principalId })
    expect(new Date(undone.undoneAt as string).getTime()).toBeGreaterThan(0)

    const listed = json(await tools.get('list_approvals')!({ status: 'undone' }))
    expect((listed.approvals as Array<{ id: string }>).map((item) => item.id)).toEqual([
      filed.approvalId,
    ])
    expect(json(await tools.get('list_approvals')!({ status: 'applied' })).approvals).toEqual([])
  })

  it("reads another key's request as not found", async () => {
    const mine = await keySession(owner)
    const filed = await propose(mine, 'Acme team')
    const theirs = await keySession(otherAdmin, ['read:settings'])
    const result = await theirs.get('get_approval')!({ approval: filed.approvalId })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('APPROVAL_NOT_FOUND')
    expect(text(result)).not.toContain('Acme team')
  })

  it('refuses a reference that is neither an approval id nor its url', async () => {
    const tools = await keySession(owner)
    for (const approval of ['post_01h455vb4pex5vsknk084sn02q', 'https://example.com/elsewhere']) {
      const result = await tools.get('get_approval')!({ approval })
      expect(result.isError).toBe(true)
    }
  })
})

describe('list_approvals', () => {
  it('lists the requests this caller follows, filtered by status and paged', async () => {
    const tools = await keySession(owner)
    const first = await propose(tools, 'One')
    const second = await propose(tools, 'Two')

    const pending = json(await tools.get('list_approvals')!({ status: 'pending' }))
    expect((pending.approvals as Array<{ id: string }>).map((item) => item.id)).toEqual([
      second.approvalId,
      first.approvalId,
    ])
    expect(pending.hasMore).toBe(false)
    expect(pending.nextCursor).toBeNull()

    const page = json(await tools.get('list_approvals')!({ limit: 1 }))
    expect((page.approvals as Array<{ id: string }>).map((item) => item.id)).toEqual([
      second.approvalId,
    ])
    expect(page.hasMore).toBe(true)
    const rest = json(await tools.get('list_approvals')!({ limit: 1, cursor: page.nextCursor }))
    expect((rest.approvals as Array<{ id: string }>).map((item) => item.id)).toEqual([
      first.approvalId,
    ])

    const rejected = json(await tools.get('list_approvals')!({ status: 'rejected' }))
    expect(rejected.approvals).toEqual([])
  })
})

describe('a key whose creator is promoted', () => {
  it("keeps a member's role, so a high-risk request stays out of reach", async () => {
    const scopes: ApiKeyScope[] = ['read:settings', 'write:settings', 'write:changelog']
    const member = await seedPerson('member')
    const memberKey = await keySession(member, scopes, 'member')
    const filed = json(
      await (await keySession(otherAdmin, scopes)).get('propose_settings_change')!({
        changes: [{ area: 'changelog', patch: { autoSubscribe: false } }],
      })
    )
    const idsFor = async () =>
      (json(await memberKey.get('list_approvals')!({})).approvals as Array<{ id: string }>).map(
        (item) => item.id
      )
    expect(await idsFor()).toContain(filed.approvalId)

    await testDb
      .update(assistantPendingActions)
      .set({ risk: 'high' })
      .where(eq(assistantPendingActions.id, filed.approvalId as never))
    await testDb
      .update(principal)
      .set({ role: 'admin' })
      .where(eq(principal.id, member.principalId!))
    expect(await idsFor()).not.toContain(filed.approvalId)
  })
})

describe('an assistant client many people sign in through', () => {
  it('shows each person what was filed for them, plus what they could decide', async () => {
    const scopes: ApiKeyScope[] = ['read:settings', 'write:settings', 'write:changelog']
    const member = await seedPerson('member')
    const ownerTools = oauthSession(owner, scopes)
    const memberTools = oauthSession(member, scopes)
    const ownersRequest = await propose(ownerTools, 'Acme team')
    const membersRequest = json(
      await memberTools.get('propose_settings_change')!({
        changes: [{ area: 'changelog', patch: { autoSubscribe: false } }],
      })
    )
    const idsFor = async (tools: Map<string, Handler>) =>
      (json(await tools.get('list_approvals')!({})).approvals as Array<{ id: string }>).map(
        (item) => item.id
      )

    // The owner filed one, and may decide the member's changelog request.
    expect(await idsFor(ownerTools)).toEqual([membersRequest.approvalId, ownersRequest.approvalId])
    // The member shares the client but not the owner's request: the workspace
    // name is not theirs to decide.
    expect(await idsFor(memberTools)).toEqual([membersRequest.approvalId])
    const hidden = await memberTools.get('get_approval')!({ approval: ownersRequest.approvalId })
    expect(hidden.isError).toBe(true)
    expect(text(hidden)).toContain('APPROVAL_NOT_FOUND')
  })
})
