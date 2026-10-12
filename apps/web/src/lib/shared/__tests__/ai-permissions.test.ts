import { describe, expect, it } from 'vitest'
import {
  AI_ANY_PERMISSIONS,
  aiPermissionForAgent,
  aiPermissionsForAssignments,
  holdsAnyAiPermission,
} from '../ai-permissions'
import { PERMISSIONS, SYSTEM_ROLE_PERMISSIONS, type PermissionKey } from '../permissions'
import { assertRouteAnyPermission } from '../route-permission'

describe('AI permissions', () => {
  it('only the customer-facing agent needs the customer permission', () => {
    expect(aiPermissionForAgent('agent')).toBe(PERMISSIONS.AI_CUSTOMER_MANAGE)
    expect(aiPermissionForAgent('copilot')).toBe(PERMISSIONS.AI_TEAMMATE_MANAGE)
    expect(aiPermissionForAgent('workspace')).toBe(PERMISSIONS.AI_TEAMMATE_MANAGE)
  })

  it('assigning to an agent needs that agent permission', () => {
    expect(aiPermissionsForAssignments(undefined)).toEqual([])
    expect(aiPermissionsForAssignments({ agent: false, copilot: false })).toEqual([])
    expect(aiPermissionsForAssignments({ agent: true })).toEqual([PERMISSIONS.AI_CUSTOMER_MANAGE])
    expect(aiPermissionsForAssignments({ agent: true, copilot: true })).toEqual([
      PERMISSIONS.AI_CUSTOMER_MANAGE,
      PERMISSIONS.AI_TEAMMATE_MANAGE,
    ])
  })

  it('shared settings open to a holder of either permission', () => {
    for (const key of AI_ANY_PERMISSIONS) {
      expect(holdsAnyAiPermission(new Set<PermissionKey>([key]))).toBe(true)
    }
    expect(holdsAnyAiPermission(new Set<PermissionKey>([PERMISSIONS.TAG_MANAGE]))).toBe(false)
    expect(() =>
      assertRouteAnyPermission([PERMISSIONS.AI_TEAMMATE_MANAGE], AI_ANY_PERMISSIONS)
    ).not.toThrow()
    expect(() => assertRouteAnyPermission([PERMISSIONS.TAG_MANAGE], AI_ANY_PERMISSIONS)).toThrow()
    expect(() => assertRouteAnyPermission(undefined, AI_ANY_PERMISSIONS)).toThrow()
  })

  it('the Support lead holds the customer AI but not the teammate AI', () => {
    expect(SYSTEM_ROLE_PERMISSIONS.support_lead).toContain(PERMISSIONS.AI_CUSTOMER_MANAGE)
    expect(SYSTEM_ROLE_PERMISSIONS.support_lead).not.toContain(PERMISSIONS.AI_TEAMMATE_MANAGE)
    expect(SYSTEM_ROLE_PERMISSIONS.admin).toContain(PERMISSIONS.AI_TEAMMATE_MANAGE)
  })
})
