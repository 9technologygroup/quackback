import { describe, expect, it } from 'vitest'
import {
  deviceAllowedLevels,
  deviceGrantHasCapability,
  deviceGrantScope,
  deviceRequestedCapabilities,
  deviceRequestedOfflineAccess,
} from '../device-grant-scopes'
import { isChipWithinRequest } from '../domain-access'

describe('device grant scopes', () => {
  it('reads the capabilities and refresh access a request names', () => {
    expect(deviceRequestedCapabilities('openid read:feedback write:feedback')).toEqual([
      'read:feedback',
      'write:feedback',
    ])
    expect(deviceRequestedOfflineAccess('openid offline_access')).toBe(true)
    expect(deviceRequestedOfflineAccess('openid')).toBe(false)
  })

  it('treats a request with no capability as the first-connect reads', () => {
    expect(deviceRequestedCapabilities(undefined)).toEqual([
      'read:feedback',
      'read:article',
      'read:chat',
      'read:settings',
    ])
    expect(deviceRequestedCapabilities('openid offline_access')).toHaveLength(4)
  })

  it('never lets a chip exceed the request', () => {
    const allowed = deviceAllowedLevels('openid read:feedback read:article write:article')
    expect(isChipWithinRequest(allowed, 'feedback', 'read')).toBe(true)
    expect(isChipWithinRequest(allowed, 'feedback', 'read_write')).toBe(false)
    expect(isChipWithinRequest(allowed, 'article', 'read_write')).toBe(true)
    expect(isChipWithinRequest(allowed, 'chat', 'read')).toBe(false)
    expect(isChipWithinRequest(allowed, 'changelog', 'write')).toBe(false)
  })

  it('narrows the stored scope to the request, whatever the page sent', () => {
    const scope = deviceGrantScope({
      requestedScope: 'openid read:feedback write:feedback',
      selected: ['read:feedback', 'write:settings', 'read:chat'],
      offlineAccess: true,
    })
    expect(scope).toBe('openid read:feedback')
    expect(deviceGrantHasCapability(scope)).toBe(true)
  })

  it('keeps refresh access only when it was asked for and kept on', () => {
    const base = {
      requestedScope: 'openid read:feedback offline_access',
      selected: ['read:feedback'],
    }
    expect(deviceGrantScope({ ...base, offlineAccess: true })).toBe(
      'openid offline_access read:feedback'
    )
    expect(deviceGrantScope({ ...base, offlineAccess: false })).toBe('openid read:feedback')
    expect(
      deviceGrantScope({
        requestedScope: 'openid read:feedback',
        selected: ['read:feedback'],
        offlineAccess: true,
      })
    ).toBe('openid read:feedback')
  })

  it('reports an empty selection as having no capability', () => {
    const scope = deviceGrantScope({
      requestedScope: 'openid read:feedback',
      selected: [],
      offlineAccess: false,
    })
    expect(scope).toBe('openid')
    expect(deviceGrantHasCapability(scope)).toBe(false)
  })
})
