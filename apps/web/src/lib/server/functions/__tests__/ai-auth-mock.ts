/**
 * Stand-in for the auth-helpers module in the AI settings server-function
 * tests: `requireAuth` is the test's own mock, and the assert helpers keep the
 * real semantics (dashboard scope, held permission), so a test can prove which
 * AI permission each function checks.
 */
import type { PermissionKey } from '@/lib/shared/permissions'

interface TestAuth {
  principal: { id?: string; role?: string }
  scope?: string
  permissions?: PermissionKey[]
}

function deny(permissions: readonly PermissionKey[]): never {
  throw new Error(`Access denied: Requires permission '${permissions.join("' or '")}'`)
}

export function assertAnyPermission(auth: TestAuth, permissions: readonly PermissionKey[]): void {
  if (auth.scope !== 'dashboard') deny(permissions)
  if (!permissions.some((p) => auth.permissions?.includes(p))) deny(permissions)
}

export function assertPermission(auth: TestAuth, permission: PermissionKey): void {
  assertAnyPermission(auth, [permission])
}

export function aiAuthHelpers(requireAuth: unknown) {
  return { requireAuth, assertAnyPermission, assertPermission }
}

/** A dashboard auth context holding exactly these permissions. */
export function dashboardAuth(permissions: PermissionKey[], id = 'principal_admin'): TestAuth {
  return { principal: { id, role: 'member' }, scope: 'dashboard', permissions }
}
