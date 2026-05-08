/**
 * Suspension guard — chokepoint helper for declarative workspace
 * suspension.
 *
 * `settings.state` carries the trinary 'active' | 'suspended' |
 * 'deleting' and is written by the config-file reconciler. With no
 * config file present, the column stays at its 'active' DB default and
 * this guard is a no-op for every request.
 *
 * This module exposes:
 * - `ensureNotSuspended()` — call from a request chokepoint to throw
 *   402 / 410 for non-active workspaces.
 * - `isSuspensionExempt(path)` — for HTML page-load guards (used by
 *   `__root.tsx`'s `beforeLoad`) so login/auth/health endpoints stay
 *   reachable on a suspended workspace.
 *
 * The `_internal` form takes an injected `readState` so unit tests
 * stay free of DB / cache imports.
 */
import { DomainException } from '@/lib/shared/errors'

/** HTTP 402 — Payment Required. The workspace stays read-blocked
 *  until something clears the suspended state. */
export class SuspendedError extends DomainException {
  readonly statusCode = 402
  constructor() {
    super('WORKSPACE_SUSPENDED', 'Workspace is suspended for non-payment.')
  }
}

/** HTTP 410 — Gone. The workspace is being deleted; data may be
 *  partially purged and no further writes are accepted. */
export class DeletingError extends DomainException {
  readonly statusCode = 410
  constructor() {
    super('WORKSPACE_DELETING', 'Workspace is being deleted.')
  }
}

/**
 * Path prefixes that stay reachable while the workspace is suspended
 * or deleting. The list is intentionally small: only what users need
 * to get back in (login, OAuth completion) and what health checks need
 * (`/api/health`, `/.well-known/`).
 *
 * Whole-path equality OR prefix-match. `/api/auth/` matches itself
 * and any descendant such as `/api/auth/sign-in/email`.
 */
export const SUSPENSION_EXEMPT_PATHS = [
  '/suspended',
  '/admin/login',
  '/admin/signup',
  '/auth/',
  '/api/auth/',
  '/api/health',
  '/oauth/',
  '/.well-known/',
  '/complete-signup/',
  // Magic-link landing — without this, a suspended workspace's owner
  // can't click an email link back into the portal.
  '/verify-magic-link',
] as const

export function isSuspensionExempt(p: string): boolean {
  return SUSPENSION_EXEMPT_PATHS.some((prefix) => p === prefix || p.startsWith(prefix))
}

/**
 * Block the current request when the workspace isn't active.
 *
 * Lazy-imports `getTenantSettings` to keep this module out of the
 * client bundle and so call-sites in cold paths don't pay the cost
 * unless they actually invoke the guard.
 */
export async function ensureNotSuspended(): Promise<void> {
  const { getTenantSettings } = await import('@/lib/server/domains/settings/settings.service')
  await _internalEnsureNotSuspended(async () => {
    const s = await getTenantSettings()
    return (s?.state ?? 'active') as 'active' | 'suspended' | 'deleting'
  })
}

/** Test seam — accepts an injected reader so the unit tests stay
 *  free of DB / Redis imports. */
export async function _internalEnsureNotSuspended(
  readState: () => Promise<'active' | 'suspended' | 'deleting'>
): Promise<void> {
  const state = await readState()
  if (state === 'suspended') throw new SuspendedError()
  if (state === 'deleting') throw new DeletingError()
}
