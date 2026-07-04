/**
 * Real-DB coverage for workflow CRUD (§4.6, Slice 5b): create with graph defaults,
 * the lifecycle transition, drag order, the soft-delete filter, and the
 * dispatcher's live-for-trigger read (which excludes draft/paused/deleted and
 * other triggers). Runs inside the db-test-fixture rollback transaction.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'

import { createDbTestFixture } from '@/lib/server/__tests__/db-test-fixture'
import { workflows } from '@/lib/server/db'

vi.mock('@/lib/server/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/db')>()),
  db: (await import('@/lib/server/__tests__/db-test-fixture')).testDb,
}))

import {
  createWorkflow,
  listWorkflows,
  getWorkflow,
  updateWorkflow,
  setWorkflowStatus,
  softDeleteWorkflow,
  listLiveWorkflowsForTrigger,
} from '../workflow.service'

const fixture = await createDbTestFixture({
  probe: async (db) => {
    await db.select({ id: workflows.id }).from(workflows).limit(0)
  },
})

describe.skipIf(!fixture.available)('workflow.service (real DB, rolled back)', () => {
  beforeEach(fixture.begin)
  afterEach(fixture.rollback)
  afterAll(fixture.close)

  it('creates with graph/settings defaults and reads back', async () => {
    const wf = await createWorkflow({
      name: 'Route billing',
      class: 'background',
      triggerType: 'conversation.created',
    })
    expect(wf.status).toBe('draft')
    expect(wf.graph).toEqual({ nodes: [], edges: [] })
    expect(wf.triggerSettings).toEqual({})
    expect((await getWorkflow(wf.id))?.id).toBe(wf.id)
  })

  it('updates the graph + settings and transitions lifecycle', async () => {
    const wf = await createWorkflow({
      name: 'Greet',
      class: 'customer_facing',
      triggerType: 'conversation.created',
    })
    const graph = {
      nodes: [{ id: 't', type: 'trigger' as const }],
      edges: [],
    }
    const updated = await updateWorkflow(wf.id, {
      graph,
      triggerSettings: { channels: ['messenger'] },
    })
    expect(updated.graph).toEqual(graph)
    expect(updated.triggerSettings).toEqual({ channels: ['messenger'] })

    const live = await setWorkflowStatus(wf.id, 'live')
    expect(live.status).toBe('live')
  })

  it('lists in drag order and hides soft-deleted', async () => {
    const a = await createWorkflow({
      name: 'A',
      class: 'background',
      triggerType: 'x',
      sortOrder: 2,
    })
    const b = await createWorkflow({
      name: 'B',
      class: 'background',
      triggerType: 'x',
      sortOrder: 1,
    })
    const list = await listWorkflows()
    expect(list.map((w) => w.id)).toEqual([b.id, a.id]) // sortOrder asc

    await softDeleteWorkflow(a.id)
    expect((await listWorkflows()).map((w) => w.id)).toEqual([b.id])
    expect(await getWorkflow(a.id)).toBeNull()
  })

  it('live-for-trigger excludes draft/paused/deleted and other triggers', async () => {
    const liveA = await createWorkflow({
      name: 'liveA',
      class: 'background',
      triggerType: 'msg',
      sortOrder: 1,
    })
    await setWorkflowStatus(liveA.id, 'live')
    const liveB = await createWorkflow({
      name: 'liveB',
      class: 'customer_facing',
      triggerType: 'msg',
      sortOrder: 0,
    })
    await setWorkflowStatus(liveB.id, 'live')
    const draft = await createWorkflow({ name: 'draft', class: 'background', triggerType: 'msg' })
    const otherTrigger = await createWorkflow({
      name: 'other',
      class: 'background',
      triggerType: 'assign',
    })
    await setWorkflowStatus(otherTrigger.id, 'live')

    const forMsg = await listLiveWorkflowsForTrigger('msg')
    // Only the two live 'msg' workflows, in sortOrder (liveB=0 before liveA=1).
    expect(forMsg.map((w) => w.id)).toEqual([liveB.id, liveA.id])
    expect(forMsg.some((w) => w.id === draft.id)).toBe(false)
    expect(forMsg.some((w) => w.id === otherTrigger.id)).toBe(false)
  })
})
