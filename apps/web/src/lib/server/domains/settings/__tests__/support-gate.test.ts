import { describe, it, expect, beforeEach, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  mockIsFeatureEnabled: vi.fn(),
  mockGetPortalConfig: vi.fn(),
  mockIsMessengerEnabled: vi.fn(),
}))

vi.mock('../settings.service', () => ({
  isFeatureEnabled: hoisted.mockIsFeatureEnabled,
  getPortalConfig: hoisted.mockGetPortalConfig,
}))

vi.mock('../settings.widget', () => ({
  isMessengerEnabled: hoisted.mockIsMessengerEnabled,
}))

import { isPortalSupportEnabled, isConversationsEnabled } from '../settings.support'
import { DEFAULT_PORTAL_CONFIG } from '../settings.types'

describe('DEFAULT_PORTAL_CONFIG.support', () => {
  it('is disabled by default so shipping the gate changes nothing for existing workspaces', () => {
    expect(DEFAULT_PORTAL_CONFIG.support?.enabled).toBe(false)
  })
})

describe('isPortalSupportEnabled', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    { flag: true, support: { enabled: true }, expected: true },
    { flag: false, support: { enabled: true }, expected: false },
    { flag: true, support: { enabled: false }, expected: false },
    { flag: true, support: undefined, expected: false },
  ])('flag=$flag support=$support → $expected', async ({ flag, support, expected }) => {
    hoisted.mockIsFeatureEnabled.mockResolvedValue(flag)
    hoisted.mockGetPortalConfig.mockResolvedValue({ support })
    expect(await isPortalSupportEnabled()).toBe(expected)
  })

  it('checks the supportInbox feature flag specifically', async () => {
    hoisted.mockIsFeatureEnabled.mockResolvedValue(true)
    hoisted.mockGetPortalConfig.mockResolvedValue({ support: { enabled: true } })
    await isPortalSupportEnabled()
    expect(hoisted.mockIsFeatureEnabled).toHaveBeenCalledWith('supportInbox')
  })
})

describe('isConversationsEnabled', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hoisted.mockIsFeatureEnabled.mockResolvedValue(true)
  })

  it.each([
    { widget: true, portalSupport: false, expected: true },
    { widget: false, portalSupport: true, expected: true },
    { widget: true, portalSupport: true, expected: true },
    { widget: false, portalSupport: false, expected: false },
  ])(
    'widget=$widget portalSupport=$portalSupport → $expected',
    async ({ widget, portalSupport, expected }) => {
      hoisted.mockIsMessengerEnabled.mockResolvedValue(widget)
      hoisted.mockGetPortalConfig.mockResolvedValue({ support: { enabled: portalSupport } })
      expect(await isConversationsEnabled()).toBe(expected)
    }
  )
})
