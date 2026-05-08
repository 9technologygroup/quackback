/**
 * Late-arriving SSO_OIDC_CLIENT_SECRET retry.
 *
 * Some deployments project the SSO client secret into env from a
 * Secret-store sidecar that may populate after the pod has booted. If
 * the first `createAuth()` call captures a missing secret, the SSO
 * provider would be permanently absent until restart — a hard outage
 * for workspaces whose admins only have OIDC login.
 *
 * Re-checking env after a short delay and clearing the cached auth
 * instance on success lets the next request rebuild the auth instance
 * with SSO registered. Side effects (read env, call resetAuth) are
 * injected so this helper can be unit-tested without pulling
 * better-auth + the DB into the test bundle.
 */

const SSO_SECRET_RETRY_MS = 60_000

export interface SsoRetryDeps {
  getSecret: () => string | undefined
  resetAuth: () => void
  schedule: (fn: () => void, ms: number) => unknown
  cancel: (handle: unknown) => void
  log?: (msg: string) => void
}

export interface SsoRetryHandle {
  /** Test-only: cancel any pending retry. */
  cancel(): void
}

let _activeHandle: unknown = null

export function scheduleSsoSecretRetry(deps: SsoRetryDeps): void {
  if (_activeHandle) return
  const fire = () => {
    _activeHandle = null
    if (deps.getSecret()) {
      deps.log?.('[auth] SSO_OIDC_CLIENT_SECRET materialized; re-initializing auth')
      deps.resetAuth()
      return
    }
    // Secret still missing. Re-arm rather than waiting on an unrelated
    // resetAuth() to queue the next check — `_auth` stays cached, so
    // ordinary requests do NOT re-enter createAuth(). Without this loop,
    // a secret that arrives after the first 60s window would leave SSO
    // unavailable until pod restart.
    armTimer(deps, fire)
  }
  armTimer(deps, fire)
}

function armTimer(deps: SsoRetryDeps, fire: () => void): void {
  const handle = deps.schedule(fire, SSO_SECRET_RETRY_MS)
  _activeHandle = handle
  // Don't keep the Node event loop alive just for this retry — important
  // in tests + during SIGTERM, where we'd otherwise hang for the full
  // 60s waiting on the timer.
  if (handle && typeof handle === 'object' && 'unref' in handle) {
    ;(handle as { unref: () => void }).unref()
  }
}

/** Test-only: cancel any pending retry so vitest can exit cleanly. */
export function _cancelSsoSecretRetry(deps: Pick<SsoRetryDeps, 'cancel'>): void {
  if (_activeHandle) {
    deps.cancel(_activeHandle)
    _activeHandle = null
  }
}

export const _ssoSecretRetryMsForTests = SSO_SECRET_RETRY_MS
