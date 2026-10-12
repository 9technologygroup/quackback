/**
 * Every job runs as background work: changes a job makes are attributed to the
 * `system` channel, whatever scope happened to arm the runner.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanupQueues, closeHarness, ensureJobQueueSchema, testDb, uniqueQueue } from './harness'

vi.mock('@/lib/server/db', () => ({
  db: new Proxy(
    {},
    {
      get(_t, prop) {
        const handle = testDb()
        const value = Reflect.get(handle as object, prop, handle)
        return typeof value === 'function' ? value.bind(handle) : value
      },
    }
  ),
}))

vi.mock('@/lib/server/workspaces/workspace-context', () => ({
  getCurrentWorkspace: () => null,
}))

import { __setJobDefinitionsForTests } from '../definitions'
import { claimJobs, enqueueJob } from '../job-queue'
import { resetJobHandlers, runJob } from '../runner'
import {
  getAuditAttribution,
  runWithAuditAttribution,
  UI_ATTRIBUTION,
} from '@/lib/server/audit/attribution'

const created: string[] = []

beforeAll(async () => {
  await ensureJobQueueSchema()
})

afterEach(() => {
  __setJobDefinitionsForTests(null)
  resetJobHandlers()
})

afterAll(async () => {
  await cleanupQueues(created)
  await closeHarness()
})

async function claimOne(label: string, seen: unknown[]) {
  const q = uniqueQueue(label)
  created.push(q)
  __setJobDefinitionsForTests([
    {
      name: q,
      maxAttempts: 1,
      leaseMs: 30_000,
      handler: async () => async () => {
        await Promise.resolve()
        seen.push(getAuditAttribution())
      },
    },
  ])
  await enqueueJob({ queue: q, maxAttempts: 1 })
  const [job] = await claimJobs({ specs: [{ queue: q, limit: 1, leaseMs: 30_000 }] })
  if (!job) throw new Error('fixture fault: the job was not claimed')
  return job
}

describe('job audit attribution', () => {
  it('runs a job handler under the system channel', async () => {
    const seen: unknown[] = []
    const job = await claimOne('audit-system', seen)
    expect(await runJob(job)).toBe('succeeded')
    expect(seen).toEqual([{ channel: 'system' }])
  })

  it('does not inherit the attribution of whatever armed the runner', async () => {
    // A runner armed inside a request would otherwise carry that request's
    // `ui` attribution onto every job it ever runs.
    const seen: unknown[] = []
    const job = await claimOne('audit-armed', seen)
    await runWithAuditAttribution(UI_ATTRIBUTION, () => runJob(job))
    expect(seen).toEqual([{ channel: 'system' }])
  })
})
