import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

const isFeatureEnabled = vi.fn<(flag: string) => Promise<boolean>>()
vi.mock('@/lib/server/domains/settings/settings.service', () => ({ isFeatureEnabled }))

import { isEventingV2Enabled } from '../eventing-v2-flag'

/**
 * WO-16 — the cutover gate: env override wins, else the DB `eventingV2` flag,
 * and it fails closed to the legacy path if settings can't be read.
 */
describe('isEventingV2Enabled (WO-16 gate)', () => {
  const prev = process.env.EVENTING_V2_RELAY
  beforeEach(() => {
    delete process.env.EVENTING_V2_RELAY
    isFeatureEnabled.mockReset()
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.EVENTING_V2_RELAY
    else process.env.EVENTING_V2_RELAY = prev
  })

  it('env override forces on without touching settings', async () => {
    process.env.EVENTING_V2_RELAY = 'true'
    expect(await isEventingV2Enabled()).toBe(true)
    expect(isFeatureEnabled).not.toHaveBeenCalled()
  })

  it('falls through to the DB feature flag when the env override is absent', async () => {
    isFeatureEnabled.mockResolvedValue(true)
    expect(await isEventingV2Enabled()).toBe(true)
    expect(isFeatureEnabled).toHaveBeenCalledWith('eventingV2')
  })

  it('is off by default (flag false)', async () => {
    isFeatureEnabled.mockResolvedValue(false)
    expect(await isEventingV2Enabled()).toBe(false)
  })

  it('fails closed to the legacy path if settings throw', async () => {
    isFeatureEnabled.mockRejectedValue(new Error('settings unavailable'))
    expect(await isEventingV2Enabled()).toBe(false)
  })
})
