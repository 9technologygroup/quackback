/**
 * The fleet-wide cap holds across claims in flight.
 *
 * Each workspace loop claims on its own connection, and on a worker start or
 * after a database restart they all claim at once against the same backlog.
 * Counted only once a claim returned, every one of them saw the last slot free
 * and took it: the cap meant nothing at exactly the moment it exists for. A
 * claim reserves its slots before it goes out and gives back what it did not
 * fill.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

interface PendingClaim {
  specs: Array<{ queue: string; limit: number }>
  resolve: (rows: unknown[]) => void
  reject: (err: Error) => void
}

const { claims, byIdClaims } = vi.hoisted(() => ({
  claims: [] as PendingClaim[],
  byIdClaims: [] as Array<(row: unknown) => void>,
}))

vi.mock('@/lib/server/logger', () => {
  const quiet = { info() {}, warn() {}, error() {}, debug() {}, child: () => quiet }
  return { logger: quiet }
})
vi.mock('@/lib/server/workspaces/workspace-context', () => ({ getCurrentWorkspace: () => null }))
vi.mock('../job-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../job-queue')>()),
  // A claim that stays in flight until the test settles it: a slow database.
  claimJobs: (input: { specs: Array<{ queue: string; limit: number }> }) =>
    new Promise((resolve, reject) => {
      claims.push({
        specs: input.specs.map(({ queue, limit }) => ({ queue, limit })),
        resolve: resolve as (rows: unknown[]) => void,
        reject,
      })
    }),
  peekRunnableJob: async () => ({ queue: 'heavy' }),
  claimById: () => new Promise((resolve) => byIdClaims.push(resolve)),
}))

import { __setJobDefinitionsForTests } from '../definitions'
import { createJobPool, dispatchPass, runnerConfig, startJobsById } from '../runner'

const config = { ...runnerConfig(), batchSize: 10, maxConcurrency: 50 }

/** A capped queue, and an uncapped one so every poll still sends a claim. */
function withHeavyCap(cap: number) {
  __setJobDefinitionsForTests([
    { name: 'heavy', fleetConcurrency: cap, handler: async () => async () => {} },
    { name: 'light', concurrency: 5, handler: async () => async () => {} },
  ])
}

function heavyAsked(claim: PendingClaim | undefined): number {
  return claim?.specs.find((s) => s.queue === 'heavy')?.limit ?? 0
}

function heavyRow(n: number) {
  return { id: String(n), jobId: `job-${n}`, queue: 'heavy', payload: {}, attempts: 1 }
}

/** A poll from a fresh workspace loop; resolves once its claim is out. */
async function poll(run: () => Promise<'succeeded'> = async () => 'succeeded') {
  const before = claims.length
  const pass = dispatchPass({ pool: createJobPool(), config, run })
  await vi.waitFor(() => expect(claims.length).toBe(before + 1))
  return { pass, claim: claims[before] }
}

afterEach(async () => {
  for (const claim of claims.splice(0)) claim.resolve([])
  for (const settle of byIdClaims.splice(0)) settle(null)
  __setJobDefinitionsForTests(null)
})

describe('the fleet-wide cap', () => {
  it('lets claims in flight together ask for no more than the cap between them', async () => {
    withHeavyCap(2)
    // Five workspaces claim at once, as every loop does when the worker starts.
    const polls = []
    for (let i = 0; i < 5; i++) polls.push(await poll())

    expect(polls.map((p) => heavyAsked(p.claim))).toEqual([1, 1, 0, 0, 0])
    // The other queues are claimed as before.
    expect(polls.every((p) => p.claim.specs.some((s) => s.queue === 'light'))).toBe(true)
  })

  it('frees the slots a claim did not fill as soon as it returns', async () => {
    withHeavyCap(2)
    const first = await poll()
    const second = await poll()
    first.claim.resolve([])
    second.claim.resolve([])
    await Promise.all([first.pass, second.pass])

    const next = await poll()
    const after = await poll()
    expect([heavyAsked(next.claim), heavyAsked(after.claim)]).toEqual([1, 1])
  })

  it('gives back the slots of a claim that failed', async () => {
    withHeavyCap(1)
    const failing = await poll()
    failing.claim.reject(new Error('connection reset'))
    await expect(failing.pass).rejects.toThrow('connection reset')

    const next = await poll()
    expect(heavyAsked(next.claim)).toBe(1)
  })

  it('holds a started job’s slot until the job settles', async () => {
    withHeavyCap(1)
    let finish!: () => void
    const running = new Promise<'succeeded'>((resolve) => {
      finish = () => resolve('succeeded')
    })
    const first = await poll(() => running)
    first.claim.resolve([heavyRow(1)])
    await first.pass

    const whileRunning = await poll()
    expect(heavyAsked(whileRunning.claim)).toBe(0)
    whileRunning.claim.resolve([])
    await whileRunning.pass

    finish()
    await running
    // Let the settle handler run before the next poll looks at the cap.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const next = await poll()
    expect(heavyAsked(next.claim)).toBe(1)
  })

  it('holds the slot of a start-by-id claim while it is in flight', async () => {
    withHeavyCap(1)
    const byId = startJobsById({
      pool: createJobPool(),
      config,
      jobIds: ['job-9'],
      run: async () => 'succeeded',
    })
    await vi.waitFor(() => expect(byIdClaims).toHaveLength(1))

    const meanwhile = await poll()
    expect(heavyAsked(meanwhile.claim)).toBe(0)

    // Another worker took the row first, so this claim comes back empty.
    byIdClaims[0](null)
    expect(await byId).toBe(0)
    const next = await poll()
    expect(heavyAsked(next.claim)).toBe(1)
  })
})
