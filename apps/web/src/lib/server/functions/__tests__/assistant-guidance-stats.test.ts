/**
 * Guidance-rule stats server fn: permission gate + delegation. createServerFn
 * is stubbed to a directly-callable fn (mirrors assistant-guidance.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PERMISSIONS } from '@/lib/shared/permissions'

vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => {
    let _handler: (() => Promise<unknown>) | null = null
    const fn = async () => {
      if (!_handler) throw new Error('handler not registered')
      return _handler()
    }
    fn.handler = (h: () => Promise<unknown>) => {
      _handler = h
      return fn
    }
    return fn
  },
}))

const hoisted = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getGuidanceRuleStats: vi.fn(),
}))

vi.mock('@/lib/server/functions/auth-helpers', async () =>
  (await import('./ai-auth-mock')).aiAuthHelpers(hoisted.requireAuth)
)
vi.mock('@/lib/server/domains/assistant/guidance-stats', () => ({
  getGuidanceRuleStats: hoisted.getGuidanceRuleStats,
}))

import { getGuidanceRuleStatsFn } from '../assistant-guidance-stats'
import { dashboardAuth } from './ai-auth-mock'

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.requireAuth.mockResolvedValue(
    dashboardAuth([PERMISSIONS.AI_CUSTOMER_MANAGE, PERMISSIONS.AI_TEAMMATE_MANAGE])
  )
  hoisted.getGuidanceRuleStats.mockResolvedValue({})
})

describe('getGuidanceRuleStatsFn', () => {
  it('opens to a holder of either AI permission and refuses everyone else', async () => {
    for (const held of [PERMISSIONS.AI_CUSTOMER_MANAGE, PERMISSIONS.AI_TEAMMATE_MANAGE]) {
      hoisted.requireAuth.mockResolvedValue(dashboardAuth([held]))
      await expect(getGuidanceRuleStatsFn()).resolves.toBeDefined()
    }
    hoisted.requireAuth.mockResolvedValue(dashboardAuth([PERMISSIONS.TAG_MANAGE]))
    await expect(getGuidanceRuleStatsFn()).rejects.toThrow('Access denied')
  })

  it('propagates an auth rejection without touching the domain layer', async () => {
    hoisted.requireAuth.mockRejectedValue(new Error('Access denied'))
    await expect(getGuidanceRuleStatsFn()).rejects.toThrow('Access denied')
    expect(hoisted.getGuidanceRuleStats).not.toHaveBeenCalled()
  })

  it('returns Applied count and lastAppliedAt from the domain layer as-is', async () => {
    const lastAppliedAt = new Date('2026-07-02T00:00:00.000Z')
    hoisted.getGuidanceRuleStats.mockResolvedValue({
      assistant_guidance_1: { applied: 2, lastAppliedAt },
    })
    const result = await getGuidanceRuleStatsFn()
    expect(result).toEqual({
      assistant_guidance_1: { applied: 2, lastAppliedAt },
    })
  })
})
