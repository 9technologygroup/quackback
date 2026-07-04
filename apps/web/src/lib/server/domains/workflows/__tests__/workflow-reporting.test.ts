/**
 * Real-DB coverage for workflow effectiveness reporting (§7): per-workflow run
 * counts by state over a date range. Fixture rollback.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'

import { createDbTestFixture, testDb } from '@/lib/server/__tests__/db-test-fixture'
import { workflows, workflowRuns, type Workflow } from '@/lib/server/db'

vi.mock('@/lib/server/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/db')>()),
  db: (await import('@/lib/server/__tests__/db-test-fixture')).testDb,
}))

import { workflowEffectiveness } from '../workflow-reporting'

const fixture = await createDbTestFixture({
  probe: async (db) => {
    await db.select({ id: workflowRuns.id }).from(workflowRuns).limit(0)
  },
})

const suffix = () => `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

async function seedWorkflow(): Promise<Workflow> {
  const [row] = await testDb
    .insert(workflows)
    .values({ name: `wf-${suffix()}`, class: 'background', triggerType: 'x' })
    .returning()
  return row
}

describe.skipIf(!fixture.available)('workflowEffectiveness (real DB, rolled back)', () => {
  beforeEach(fixture.begin)
  afterEach(fixture.rollback)
  afterAll(fixture.close)

  it('aggregates run states per workflow within the range', async () => {
    const wf = await seedWorkflow()
    const run = (state: string, startedAt: string) => ({
      workflowId: wf.id,
      state: state as never,
      startedAt: new Date(startedAt),
    })
    await testDb.insert(workflowRuns).values([
      run('done', '2026-01-05T10:00:00Z'),
      run('done', '2026-01-05T11:00:00Z'),
      run('interrupted', '2026-01-05T12:00:00Z'),
      run('waiting', '2026-01-05T13:00:00Z'),
      // Outside the range — excluded.
      run('done', '2026-02-01T10:00:00Z'),
    ])

    const res = await workflowEffectiveness(
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-02-01T00:00:00Z')
    )
    expect(res).toHaveLength(1)
    expect(res[0]).toEqual({
      workflowId: wf.id,
      started: 4, // every in-range run
      completed: 2,
      interrupted: 1,
      waiting: 1,
    })
  })

  it('returns an empty array when no runs fall in the range', async () => {
    await seedWorkflow()
    const res = await workflowEffectiveness(
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-01-02T00:00:00Z')
    )
    expect(res).toEqual([])
  })
})
