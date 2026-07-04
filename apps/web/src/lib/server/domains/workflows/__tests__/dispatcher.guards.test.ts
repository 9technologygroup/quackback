/**
 * Real-DB coverage for the dispatcher guards (§4.6, Slice 5d-ii): each frequency
 * cap type counted from the run-event ledger, and the customer_facing exclusive
 * lock (which ignores background runs and ended runs). Runs inside the fixture
 * rollback.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import {
  createId,
  type PrincipalId,
  type UserId,
  type ConversationId,
  type WorkflowId,
  type WorkflowRunId,
} from '@quackback/ids'

import { createDbTestFixture, testDb } from '@/lib/server/__tests__/db-test-fixture'
import {
  workflows,
  workflowRuns,
  workflowRunEvents,
  conversations,
  user,
  principal,
  type Workflow,
} from '@/lib/server/db'

vi.mock('@/lib/server/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/db')>()),
  db: (await import('@/lib/server/__tests__/db-test-fixture')).testDb,
}))

import { frequencyCapAllows, hasActiveCustomerFacingRun } from '../dispatcher.guards'

const fixture = await createDbTestFixture({
  probe: async (db) => {
    await db.select({ id: workflows.id }).from(workflows).limit(0)
    await db.select({ id: workflowRuns.id }).from(workflowRuns).limit(0)
  },
})

const suffix = () => `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

async function seedWorkflow(
  cls: 'customer_facing' | 'background',
  triggerSettings: Record<string, unknown> = {}
): Promise<Workflow> {
  const [row] = await testDb
    .insert(workflows)
    .values({ name: `wf-${suffix()}`, class: cls, triggerType: 'x', triggerSettings })
    .returning()
  return row
}

async function seedPrincipal(): Promise<PrincipalId> {
  const userId = createId('user') as UserId
  const principalId = createId('principal') as PrincipalId
  await testDb.insert(user).values({ id: userId, name: `V-${suffix()}` })
  await testDb
    .insert(principal)
    .values({ id: principalId, userId, role: 'member', type: 'user', createdAt: new Date() })
  return principalId
}

async function seedConversation(): Promise<ConversationId> {
  const principalId = await seedPrincipal()
  const [row] = await testDb
    .insert(conversations)
    .values({ visitorPrincipalId: principalId, channel: 'messenger' })
    .returning()
  return row.id
}

/** Record N 'started' events for (workflow, principal), optionally aged. */
async function seedStarts(
  workflowId: WorkflowId,
  subjectPrincipalId: PrincipalId,
  n: number,
  at?: Date
): Promise<void> {
  const runId = createId('workflow_run') as WorkflowRunId
  await testDb
    .insert(workflowRuns)
    .values({ id: runId, workflowId, subjectPrincipalId, state: 'done' })
  for (let i = 0; i < n; i++) {
    await testDb
      .insert(workflowRunEvents)
      .values({ runId, workflowId, subjectPrincipalId, kind: 'started', ...(at ? { at } : {}) })
  }
}

describe.skipIf(!fixture.available)('dispatcher guards (real DB, rolled back)', () => {
  beforeEach(fixture.begin)
  afterEach(fixture.rollback)
  afterAll(fixture.close)

  it('no cap / unlimited / anonymous subject are always allowed', async () => {
    const none = await seedWorkflow('background')
    const unlimited = await seedWorkflow('background', { frequencyCap: { type: 'unlimited' } })
    const principalId = createId('principal') as PrincipalId
    expect(await frequencyCapAllows(none, principalId)).toBe(true)
    expect(await frequencyCapAllows(unlimited, principalId)).toBe(true)
    // A per-person 'once' cap can't key on an anonymous (null) subject -> allowed.
    const once = await seedWorkflow('background', { frequencyCap: { type: 'once' } })
    expect(await frequencyCapAllows(once, null)).toBe(true)
  })

  it('once: allowed until the first run, then blocked', async () => {
    const wf = await seedWorkflow('background', { frequencyCap: { type: 'once' } })
    const p = await seedPrincipal()
    expect(await frequencyCapAllows(wf, p)).toBe(true)
    await seedStarts(wf.id, p, 1)
    expect(await frequencyCapAllows(wf, p)).toBe(false)
  })

  it('once_per_days: an old run does not count, a recent one does', async () => {
    const wf = await seedWorkflow('background', {
      frequencyCap: { type: 'once_per_days', days: 7 },
    })
    const p = await seedPrincipal()
    await seedStarts(wf.id, p, 1, new Date(Date.now() - 30 * 86_400_000)) // 30d ago
    expect(await frequencyCapAllows(wf, p)).toBe(true) // outside the 7d window
    await seedStarts(wf.id, p, 1) // now
    expect(await frequencyCapAllows(wf, p)).toBe(false)
  })

  it('n_total: allowed while under the count', async () => {
    const wf = await seedWorkflow('background', { frequencyCap: { type: 'n_total', count: 3 } })
    const p = await seedPrincipal()
    await seedStarts(wf.id, p, 2)
    expect(await frequencyCapAllows(wf, p)).toBe(true) // 2 < 3
    await seedStarts(wf.id, p, 1)
    expect(await frequencyCapAllows(wf, p)).toBe(false) // 3 >= 3
  })

  it('hasActiveCustomerFacingRun sees a live customer_facing run only', async () => {
    const conversationId = await seedConversation()
    expect(await hasActiveCustomerFacingRun(conversationId)).toBe(false)

    // A background run on the conversation does not lock it.
    const bg = await seedWorkflow('background')
    await testDb
      .insert(workflowRuns)
      .values({ workflowId: bg.id, conversationId, state: 'running' })
    expect(await hasActiveCustomerFacingRun(conversationId)).toBe(false)

    // An ENDED customer_facing run does not lock it.
    const cf = await seedWorkflow('customer_facing')
    await testDb.insert(workflowRuns).values({ workflowId: cf.id, conversationId, state: 'done' })
    expect(await hasActiveCustomerFacingRun(conversationId)).toBe(false)

    // A running customer_facing run does.
    await testDb
      .insert(workflowRuns)
      .values({ workflowId: cf.id, conversationId, state: 'waiting' })
    expect(await hasActiveCustomerFacingRun(conversationId)).toBe(true)
  })
})
