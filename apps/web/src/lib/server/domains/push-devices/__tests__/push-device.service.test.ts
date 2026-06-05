import { beforeEach, describe, it, expect, vi } from 'vitest'
import type { PrincipalId } from '@quackback/ids'

const onConflictDoUpdate = vi.fn()
const values = vi.fn(() => ({ onConflictDoUpdate }))
const insert = vi.fn(() => ({ values }))
const where = vi.fn()
const del = vi.fn(() => ({ where }))

vi.mock('@/lib/server/db', () => ({
  db: {
    insert: (...a: unknown[]) => insert(...a),
    delete: (...a: unknown[]) => del(...a),
  },
  // Stand-ins so target/column references are identity-comparable in asserts.
  pushDevices: { token: 'pushDevices.token' },
  eq: (col: unknown, val: unknown) => ({ __eq: [col, val] }),
}))

import { registerDevice, unregisterDevice } from '../push-device.service'

const PRINCIPAL = 'principal_abc' as PrincipalId

beforeEach(() => {
  vi.clearAllMocks()
})

describe('registerDevice', () => {
  it('upserts the device row keyed by token', async () => {
    await registerDevice({ principalId: PRINCIPAL, token: 'tok-1', platform: 'ios' })

    expect(insert).toHaveBeenCalledOnce()
    expect(values).toHaveBeenCalledWith({
      principalId: PRINCIPAL,
      token: 'tok-1',
      platform: 'ios',
    })
    const conflictArg = onConflictDoUpdate.mock.calls[0][0]
    expect(conflictArg.target).toBe('pushDevices.token')
    expect(conflictArg.set.principalId).toBe(PRINCIPAL)
    expect(conflictArg.set.platform).toBe('ios')
    expect(conflictArg.set.lastSeenAt).toBeInstanceOf(Date)
  })
})

describe('unregisterDevice', () => {
  it('deletes the row matching the token', async () => {
    await unregisterDevice('tok-1')

    expect(del).toHaveBeenCalledOnce()
    expect(where).toHaveBeenCalledWith({ __eq: ['pushDevices.token', 'tok-1'] })
  })
})
