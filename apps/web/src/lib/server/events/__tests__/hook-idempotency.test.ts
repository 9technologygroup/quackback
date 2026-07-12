/**
 * Hook idempotency unit tests.
 *
 * Exercises the claimHookDelivery dedup primitive with a mocked DB —
 * the integration angle (real Postgres ON CONFLICT semantics) is
 * exercised by the migration applying cleanly + the unique PK on
 * job_id, which Drizzle enforces at the schema level.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.mock is hoisted, so the factory can't close over module-level
// consts. Stash the mocks on globalThis instead so the test body can
// drive them.
vi.mock('@/lib/server/db', () => {
  const execute = vi.fn()
  ;(globalThis as Record<string, unknown>).__hookMocks = {
    execute,
  }
  return {
    db: { execute },
    hookDeliveries: { jobId: 'job_id', outcome: 'outcome', processedAt: 'processed_at' },
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    eq: vi.fn(),
  }
})

import { claimHookDelivery } from '../hook-idempotency'

interface HookMocks {
  execute: ReturnType<typeof vi.fn>
}

function getMocks(): HookMocks {
  return (globalThis as Record<string, unknown>).__hookMocks as HookMocks
}

describe('claimHookDelivery', () => {
  beforeEach(() => {
    const m = getMocks()
    m.execute.mockReset()
  })

  it('returns true on first claim (insert succeeded)', async () => {
    const m = getMocks()
    m.execute.mockResolvedValueOnce([{ job_id: 'job_1' }])
    const claimed = await claimHookDelivery('job_1', 'webhook')
    expect(claimed).toBe(true)
    expect(m.execute).toHaveBeenCalledOnce()
    expect(m.execute.mock.calls[0][0].values).toEqual(['job_1', 'webhook'])
  })

  it('returns false on second claim (conflict, no row returned)', async () => {
    const m = getMocks()
    m.execute.mockResolvedValueOnce([])
    const claimed = await claimHookDelivery('job_1', 'webhook')
    expect(claimed).toBe(false)
  })

  it('passes through for missing jobId (test/ad-hoc paths)', async () => {
    const m = getMocks()
    const claimed = await claimHookDelivery(undefined, 'webhook')
    expect(claimed).toBe(true)
    expect(m.execute).not.toHaveBeenCalled()
  })

  it('records the hookType so retention sweeps can target one hook', async () => {
    const m = getMocks()
    m.execute.mockResolvedValueOnce([{ job_id: 'job_2' }])
    await claimHookDelivery('job_2', 'ai')
    expect(m.execute.mock.calls[0][0].values).toEqual(['job_2', 'ai'])
  })
})
