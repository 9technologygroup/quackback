/**
 * The Approvals page against a real database: approving runs the change with
 * the executor its origin uses, every decision rule still applies, and the
 * waiting summary behind the rail and Home counts only what the viewer may
 * decide.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createId, type PrincipalId } from '@quackback/ids'
import { createDbTestFixture, testDb } from '@/lib/server/__tests__/db-test-fixture'
import {
  eq,
  principal,
  user,
  settings,
  conversations,
  tickets,
  ticketStatuses,
  assistantPendingActions,
} from '@/lib/server/db'
import { ALL_PERMISSIONS, PERMISSIONS } from '@/lib/shared/permissions'
import { permissionsForLegacyRole } from '@/lib/server/policy/permissions'
import type { Actor } from '@/lib/server/policy/types'

const executed = vi.hoisted(() => ({
  calls: [] as Array<{
    toolName: string
    pendingActionId: string
    actorId: string | null | undefined
  }>,
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
// The inbox executor runs for real up to the tool itself, which is recorded
// instead of closing a conversation.
vi.mock('../assistant.tools', async (original) => ({
  ...(await original<typeof import('../assistant.tools')>()),
  executeApprovedPendingAction: async (
    spec: { name: string },
    pending: { id: string },
    ctx: { actor?: Actor }
  ) => {
    executed.calls.push({
      toolName: spec.name,
      pendingActionId: pending.id,
      actorId: ctx.actor?.principalId,
    })
    return { status: 'executed', result: { closed: true } }
  },
}))

import { createWorkspaceThread } from '../workspace-threads.service'
import { enqueueWorkspaceSettingsProposal } from '../workspace-settings-actions.service'
import { proposePendingAction } from '../pending-actions.service'
import { approveApproval, rejectApproval } from '../approvals.service'
import { getApprovalForViewer } from '../approvals.queue'
import {
  listApprovalsForViewer,
  listDecidedApprovalsForViewer,
  pageApprovalsForViewer,
  waitingApprovalsSummary,
  railCountsFor,
} from '../approvals.queue'

const fixture = await createDbTestFixture()

let owner: Actor
let otherAdmin: Actor
let member: Actor
let threadKey: string

async function seedPerson(role: 'admin' | 'member', name: string): Promise<Actor> {
  const userId = createId('user')
  const principalId = createId('principal')
  await testDb.insert(user).values({ id: userId, name, email: `${userId}@example.com` })
  await testDb
    .insert(principal)
    .values({ id: principalId, userId, role, type: 'user', createdAt: new Date() })
  return {
    principalId,
    role,
    principalType: 'user',
    segmentIds: new Set(),
    permissions: role === 'admin' ? new Set(ALL_PERMISSIONS) : permissionsForLegacyRole('member'),
  }
}

async function seedServicePrincipal(displayName: string): Promise<PrincipalId> {
  const principalId = createId('principal')
  await testDb.insert(principal).values({
    id: principalId,
    role: 'admin',
    type: 'service',
    displayName,
    createdAt: new Date(),
  })
  return principalId
}

beforeEach(async () => {
  expect(fixture.available).toBe(true)
  await fixture.begin()
  executed.calls = []
  owner = await seedPerson('admin', 'Olive Owner')
  otherAdmin = await seedPerson('admin', 'Ada Admin')
  member = await seedPerson('member', 'Max Member')
  threadKey = (await createWorkspaceThread(owner)).key
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

const workspaceName = async () => (await testDb.select().from(settings).limit(1))[0]!.name

const rowOf = async (id: string) =>
  (
    await testDb
      .select()
      .from(assistantPendingActions)
      .where(eq(assistantPendingActions.id, id as never))
  )[0]!

async function homeProposal(patch: Record<string, unknown> = { displayName: 'Acme team' }) {
  return enqueueWorkspaceSettingsProposal(owner, [{ area: 'portal', patch }], threadKey, 'turn-1')
}

async function inboxProposal() {
  const visitor = await seedServicePrincipal('Visitor')
  const [conversation] = await testDb
    .insert(conversations)
    .values({
      visitorPrincipalId: visitor,
      channel: 'messenger',
      source: 'widget',
      createdAt: new Date(),
    })
    .returning()
  return proposePendingAction({
    conversationId: conversation!.id,
    toolName: 'end_conversation',
    args: {},
    summary: 'Close the conversation',
    requester: { via: 'assistant', onBehalfOfPrincipalId: owner.principalId! },
  })
}

describe('approving from the page', () => {
  it('applies a Home settings request with the settings executor', async () => {
    const pending = await homeProposal()
    const approved = await approveApproval(otherAdmin, pending.id, {
      contentHash: pending.argsDigest!,
    })
    expect(approved).toMatchObject({
      status: 'executed',
      decidedById: otherAdmin.principalId,
      decidedVia: 'app',
    })
    expect(await workspaceName()).toBe('Acme team')
    expect(executed.calls).toEqual([])
  })

  it('runs an inbox tool action with the tool-action executor', async () => {
    const pending = await inboxProposal()
    const approved = await approveApproval(member, pending.id, {
      contentHash: pending.argsDigest!,
    })
    expect(approved).toMatchObject({
      status: 'executed',
      decidedById: member.principalId,
      decidedVia: 'app',
    })
    expect(executed.calls).toEqual([
      { toolName: 'end_conversation', pendingActionId: pending.id, actorId: member.principalId },
    ])
  })

  it('refuses a stale content hash for either kind and leaves the request waiting', async () => {
    const settingsRequest = await homeProposal()
    await expect(
      approveApproval(otherAdmin, settingsRequest.id, { contentHash: 'not-the-digest' })
    ).rejects.toMatchObject({ code: 'APPROVAL_CONTENT_CHANGED' })
    const inbox = await inboxProposal()
    await expect(
      approveApproval(otherAdmin, inbox.id, { contentHash: 'not-the-digest' })
    ).rejects.toMatchObject({ code: 'APPROVAL_CONTENT_CHANGED' })
    expect((await rowOf(settingsRequest.id)).status).toBe('proposed')
    expect((await rowOf(inbox.id)).status).toBe('proposed')
    expect(await workspaceName()).toBe('Acme')
    expect(executed.calls).toEqual([])
  })

  it('never lets the requester approve its own request', async () => {
    const keyPrincipal = await seedServicePrincipal('Zapier key')
    const pending = await enqueueWorkspaceSettingsProposal(
      owner,
      [{ area: 'portal', patch: { displayName: 'Acme team' } }],
      undefined,
      undefined,
      { via: 'mcp', requestedById: keyPrincipal, credentialId: 'api_key_1' }
    )
    const keyActor: Actor = { ...owner, principalId: keyPrincipal, principalType: 'service' }
    await expect(
      approveApproval(keyActor, pending.id, { contentHash: pending.argsDigest! })
    ).rejects.toMatchObject({ code: 'APPROVAL_SELF_DECISION' })
    const first = await inboxProposal()
    const inbox = await proposePendingAction({
      conversationId: first.conversationId!,
      toolName: 'end_conversation',
      args: { reason: 'Resolved' },
      summary: 'Close the conversation',
      requester: { via: 'ui', requestedById: member.principalId! },
    })
    await expect(
      approveApproval(member, inbox.id, { contentHash: inbox.argsDigest! })
    ).rejects.toMatchObject({ code: 'APPROVAL_SELF_DECISION' })
    expect((await rowOf(inbox.id)).status).toBe('proposed')
  })

  it('asks for a fresh sign-in on a high-risk request', async () => {
    const pending = await homeProposal()
    await testDb
      .update(assistantPendingActions)
      .set({ risk: 'high' })
      .where(eq(assistantPendingActions.id, pending.id))
    await expect(
      approveApproval(otherAdmin, pending.id, { contentHash: pending.argsDigest! })
    ).rejects.toMatchObject({ code: 'APPROVAL_SIGN_IN_REQUIRED' })
    expect((await rowOf(pending.id)).status).toBe('proposed')
  })

  it('records the reason of a rejection', async () => {
    const pending = await inboxProposal()
    const rejected = await rejectApproval(member, pending.id, {
      contentHash: pending.argsDigest!,
      reason: 'The customer is still replying',
    })
    expect(rejected).toMatchObject({
      status: 'rejected',
      decidedById: member.principalId,
      decisionReason: 'The customer is still replying',
    })
    expect(executed.calls).toEqual([])
  })
})

describe('the waiting summary', () => {
  it('rides the unread read while nothing is open, and only then builds the actor', async () => {
    let actorBuilt = 0
    const actorOf = async () => {
      actorBuilt += 1
      return otherAdmin
    }
    expect(await railCountsFor(otherAdmin.principalId!, actorOf)).toEqual({
      unread: 0,
      waiting: { count: 0, latest: [] },
    })
    expect(actorBuilt).toBe(0)

    await homeProposal()
    const withOpen = await railCountsFor(otherAdmin.principalId!, actorOf)
    expect(actorBuilt).toBe(1)
    expect(withOpen.waiting).toEqual(await waitingApprovalsSummary(otherAdmin))
    expect(withOpen.waiting.count).toBe(1)
  })

  it('counts and lists only what the viewer may decide, with names', async () => {
    const home = await homeProposal()
    const inbox = await inboxProposal()
    const keyPrincipal = await seedServicePrincipal('Zapier key')
    const mine = await enqueueWorkspaceSettingsProposal(
      owner,
      [{ area: 'changelog', patch: { autoSubscribe: false } }],
      undefined,
      'turn-2',
      { via: 'mcp', requestedById: keyPrincipal, onBehalfOfPrincipalId: member.principalId! }
    )
    // A request the member filed themselves is never theirs to decide.
    await proposePendingAction({
      conversationId: inbox.conversationId!,
      toolName: 'end_conversation',
      args: { reason: 'Done' },
      summary: 'Close the conversation',
      requester: { via: 'ui', requestedById: member.principalId! },
    })

    const forAdmin = await waitingApprovalsSummary(otherAdmin)
    expect(forAdmin.count).toBe(4)
    expect(forAdmin.latest).toHaveLength(3)

    const forMember = await waitingApprovalsSummary(member)
    // The workspace name needs settings permissions a member lacks.
    expect(forMember.count).toBe(2)
    expect(forMember.latest.map((view) => view.id)).toEqual([mine.id, inbox.id])
    expect(forMember.latest[0]).toMatchObject({
      requestedByName: 'Zapier key',
      onBehalfOfName: 'Max Member',
    })
    expect(forMember.latest[1]).toMatchObject({ onBehalfOfName: 'Olive Owner' })
    expect(forMember.latest.map((view) => view.id)).not.toContain(home.id)

    const keyActor: Actor = { ...otherAdmin, principalId: keyPrincipal, principalType: 'service' }
    expect(await waitingApprovalsSummary(keyActor)).toEqual({ count: 0, latest: [] })
  })

  it('lists decided requests with the decision, the decider and whether undo is open', async () => {
    const applied = await homeProposal()
    await approveApproval(otherAdmin, applied.id, { contentHash: applied.argsDigest! })
    const turnedDown = await inboxProposal()
    await rejectApproval(otherAdmin, turnedDown.id, {
      contentHash: turnedDown.argsDigest!,
      reason: 'Not yet',
    })
    await inboxProposal()

    const decided = await listDecidedApprovalsForViewer(otherAdmin)
    expect(decided.map((view) => view.id)).toEqual([turnedDown.id, applied.id])
    expect(decided[0]).toMatchObject({
      status: 'rejected',
      decisionReason: 'Not yet',
      decidedByName: 'Ada Admin',
      undoable: false,
    })
    expect(decided[1]).toMatchObject({ status: 'executed', undoable: true, undone: false })
    // The member cannot decide the workspace name, so only the inbox request shows.
    expect((await listDecidedApprovalsForViewer(member)).map((view) => view.id)).toEqual([
      turnedDown.id,
    ])
  })
})

describe('one count, every request', () => {
  it('pages through every waiting request, and the count matches what the pages hold', async () => {
    const first = await inboxProposal()
    const second = await inboxProposal()
    const third = await inboxProposal()
    const page1 = await pageApprovalsForViewer(otherAdmin, { view: 'waiting', limit: 2 })
    expect(page1.items.map((view) => view.id)).toEqual([third.id, second.id])
    expect(page1.nextCursor).not.toBeNull()
    const page2 = await pageApprovalsForViewer(otherAdmin, {
      view: 'waiting',
      limit: 2,
      cursor: page1.nextCursor!,
    })
    expect(page2.items.map((view) => view.id)).toEqual([first.id])
    expect(page2.nextCursor).toBeNull()
    expect((await waitingApprovalsSummary(otherAdmin)).count).toBe(3)
  })

  it('pages through decided requests', async () => {
    const first = await inboxProposal()
    await rejectApproval(otherAdmin, first.id, { contentHash: first.argsDigest! })
    const second = await inboxProposal()
    await rejectApproval(otherAdmin, second.id, { contentHash: second.argsDigest! })
    const page1 = await pageApprovalsForViewer(otherAdmin, { view: 'decided', limit: 1 })
    expect(page1.items.map((view) => view.id)).toEqual([second.id])
    const page2 = await pageApprovalsForViewer(otherAdmin, {
      view: 'decided',
      limit: 1,
      cursor: page1.nextCursor!,
    })
    expect(page2.items.map((view) => view.id)).toEqual([first.id])
    expect(page2.nextCursor).toBeNull()
  })

  it('leaves out of what waits on a person the request their own assistant filed', async () => {
    // The owner's Home chat asked; the card is already in front of them, so
    // like the bell, the count and the queue leave it out for them.
    const home = await homeProposal()
    expect(await waitingApprovalsSummary(owner)).toEqual({ count: 0, latest: [] })
    expect((await listApprovalsForViewer(owner)).map((view) => view.id)).not.toContain(home.id)
    const forOther = await waitingApprovalsSummary(otherAdmin)
    expect(forOther.count).toBe(1)
    expect(forOther.latest.map((view) => view.id)).toEqual([home.id])
  })
})

describe('what a decision can never do', () => {
  it('never approves a request already turned down', async () => {
    const pending = await inboxProposal()
    await rejectApproval(otherAdmin, pending.id, { contentHash: pending.argsDigest! })
    await expect(
      approveApproval(member, pending.id, { contentHash: pending.argsDigest! })
    ).rejects.toMatchObject({ code: 'PENDING_ACTION_NOT_DECIDABLE' })
    expect((await rowOf(pending.id)).status).toBe('rejected')
    expect(executed.calls).toEqual([])
  })

  it('runs a request once when it is approved twice', async () => {
    const pending = await inboxProposal()
    await approveApproval(member, pending.id, { contentHash: pending.argsDigest! })
    await expect(
      approveApproval(otherAdmin, pending.id, { contentHash: pending.argsDigest! })
    ).rejects.toMatchObject({ code: 'PENDING_ACTION_NOT_DECIDABLE' })
    expect(executed.calls).toHaveLength(1)
    expect((await rowOf(pending.id)).decidedById).toBe(member.principalId)
  })

  it('treats a ticket outside the teams of a scoped viewer as not found', async () => {
    const visitor = await seedServicePrincipal('Visitor')
    const statusId = createId('ticket_status')
    await testDb.insert(ticketStatuses).values({ id: statusId, name: 'Acme open', slug: statusId })
    const [ticket] = await testDb
      .insert(tickets)
      .values({ title: 'Acme refund', statusId, requesterPrincipalId: visitor })
      .returning({ id: tickets.id })
    const pending = await proposePendingAction({
      ticketId: ticket!.id,
      toolName: 'create_ticket',
      args: { title: 'Follow up on the refund' },
      summary: 'Create a ticket',
    })
    // Sees tickets assigned to them or their teams only; this one is neither.
    const scoped: Actor = {
      ...member,
      permissions: new Set(
        [...(member.permissions ?? []), PERMISSIONS.TICKET_VIEW, PERMISSIONS.TICKET_CREATE].filter(
          (permission) => permission !== PERMISSIONS.TICKET_VIEW_ALL
        )
      ),
    }
    await expect(
      approveApproval(scoped, pending.id, { contentHash: pending.argsDigest! })
    ).rejects.toMatchObject({ code: 'APPROVAL_NOT_FOUND' })
    await expect(getApprovalForViewer(scoped, pending.id)).rejects.toMatchObject({
      code: 'APPROVAL_NOT_FOUND',
    })
    expect((await listApprovalsForViewer(scoped)).map((view) => view.id)).not.toContain(pending.id)
    expect((await listApprovalsForViewer(otherAdmin)).map((view) => view.id)).toContain(pending.id)
    expect((await rowOf(pending.id)).status).toBe('proposed')
  })

  it('never lets a member without the settings permission approve a settings request', async () => {
    const pending = await homeProposal()
    await expect(
      approveApproval(member, pending.id, { contentHash: pending.argsDigest! })
    ).rejects.toMatchObject({ code: 'APPROVAL_PERMISSION_REQUIRED' })
    expect((await rowOf(pending.id)).status).toBe('proposed')
    expect(await workspaceName()).toBe('Acme')
  })
})
