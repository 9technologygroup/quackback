import { describe, it, expect } from 'vitest'
import { permissionsForLegacyRole } from '../permissions'
import {
  ALL_PERMISSIONS,
  SYSTEM_ROLE_PERMISSIONS,
  presetForLegacyRole,
  PERMISSIONS,
} from '@/lib/server/db'
import type { Role } from '@/lib/shared/roles'

const ROLES: Role[] = ['admin', 'member', 'user']

// The compat shim's correctness proof: requireAuth({ permission: P }) checks
// permissionsForLegacyRole(role).has(P), so if the expansion equals the role's
// preset bundle, the permission gate is provably equivalent to the legacy role
// gate for every (role, permission) pair.
describe('permissionsForLegacyRole (compat shim)', () => {
  it('expands each legacy role to its preset bundle', () => {
    for (const role of ROLES) {
      const preset = presetForLegacyRole(role)
      const expected = new Set(preset ? SYSTEM_ROLE_PERMISSIONS[preset] : [])
      expect(permissionsForLegacyRole(role)).toEqual(expected)
    }
  })

  it('user (the People axis) resolves to zero permissions', () => {
    expect(permissionsForLegacyRole('user').size).toBe(0)
  })

  it('{ permission } is equivalent to the role bundle for every (role, permission) pair', () => {
    for (const role of ROLES) {
      const preset = presetForLegacyRole(role)
      const bundle = new Set<string>(preset ? SYSTEM_ROLE_PERMISSIONS[preset] : [])
      const resolved = permissionsForLegacyRole(role)
      for (const p of ALL_PERMISSIONS) {
        expect(resolved.has(p)).toBe(bundle.has(p))
      }
    }
  })

  it('admin (Owner) holds billing + settings; member (Manager) holds neither but operates', () => {
    const admin = permissionsForLegacyRole('admin')
    expect(admin.has(PERMISSIONS.BILLING_MANAGE)).toBe(true)
    expect(admin.has(PERMISSIONS.SETTINGS_MANAGE)).toBe(true)

    const member = permissionsForLegacyRole('member')
    expect(member.has(PERMISSIONS.SETTINGS_MANAGE)).toBe(false)
    expect(member.has(PERMISSIONS.MEMBER_MANAGE)).toBe(false)
    expect(member.has(PERMISSIONS.BILLING_MANAGE)).toBe(false)
    // ...but keeps the operate + non-regressing read permissions.
    expect(member.has(PERMISSIONS.POST_EDIT)).toBe(true)
    expect(member.has(PERMISSIONS.MEMBER_VIEW)).toBe(true)
    expect(member.has(PERMISSIONS.INTEGRATION_VIEW)).toBe(true)
  })
})
