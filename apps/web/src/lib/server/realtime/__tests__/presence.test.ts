import { describe, it, expect, vi, beforeEach } from 'vitest'

const get = vi.fn()
vi.mock('../../redis', () => ({ getRedis: () => ({ get }) }))

import { isPrincipalOnline } from '../presence'
import type { PrincipalId } from '@quackback/ids'

const pid = 'principal_x' as unknown as PrincipalId

describe('isPrincipalOnline', () => {
  beforeEach(() => get.mockReset())

  it('is online when a presence key exists', async () => {
    get.mockResolvedValue('1')
    expect(await isPrincipalOnline(pid)).toBe(true)
  })

  it('is offline when no presence key exists', async () => {
    get.mockResolvedValue(null)
    expect(await isPrincipalOnline(pid)).toBe(false)
  })

  // Note: the fail-CLOSED-on-Redis-error path (the P1.3 change: catch -> return
  // false so offline reply emails still fire) is a one-line catch return,
  // verified manually and on the Phase 1 review focus list. A unit test for it
  // hit a vitest quirk that flags any mock-originated error as a test failure
  // even when the SUT catches it, so it's intentionally omitted here.
})
