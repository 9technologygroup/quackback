import type { ReactNode } from 'react'
import { permissionsForRole, type PermissionKey } from '@/lib/shared/permissions'

/**
 * Render children only when the current user's role grants `permission`.
 *
 * The role is passed in (callers read it from their route context / the
 * bootstrap principal) and expanded to its preset bundle client-side, mirroring
 * the server `can()` check. This is a display convenience — the server always
 * re-checks, so a client that renders past this gate still can't act.
 */
export function PermissionGate({
  role,
  permission,
  fallback = null,
  children,
}: {
  role: string | null | undefined
  permission: PermissionKey
  fallback?: ReactNode
  children: ReactNode
}) {
  const allowed = permissionsForRole(role ?? null).has(permission)
  return <>{allowed ? children : fallback}</>
}
