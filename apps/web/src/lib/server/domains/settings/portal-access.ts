/**
 * Portal-level access evaluation.
 *
 * Decides whether a visitor may render the portal, based on the workspace's
 * configured visibility and the visitor's authentication state.
 *
 * Phase 1: team-only gate (admin | member always pass).
 * Phase 2: allowed email-domain grant (verified email required).
 * Extension points are marked below for later phases.
 */

// =============================================================================
// Types
// =============================================================================

export type PortalVisibility = 'public' | 'private'

/** Caller-supplied context — everything the evaluator needs, nothing more. */
export interface PortalAccessContext {
  /** Resolved from portalConfig.access?.visibility. Default 'public'. */
  visibility: PortalVisibility
  /**
   * Role of the current principal. `null` means anonymous (no session, or
   * the session's principalType is 'anonymous').
   */
  role: 'admin' | 'member' | 'user' | null
  /**
   * True when the visitor has a real (non-anonymous) authenticated session.
   * An anonymous Better Auth session counts as NOT authenticated.
   */
  isAuthenticated: boolean
  /**
   * Email address of the authenticated visitor. `null` when there is no
   * real session. Used for Phase 2 domain-allowlist checks.
   */
  userEmail: string | null
  /**
   * Whether the visitor's email address has been verified. An unverified
   * email must NOT match domain allowlists — anyone could claim an address
   * they don't control without this guard.
   */
  emailVerified: boolean
  /**
   * Domains whose verified users are automatically granted access to a
   * private portal. Resolved from portalConfig.access?.allowedDomains.
   */
  allowedDomains: string[]
}

/** Discriminated union — narrows cleanly in if/switch. */
export type PortalAccessResult =
  | { granted: true; reason: 'public' | 'team' | 'domain' }
  | { granted: false; reason: 'unauthenticated' | 'unauthorized' }

// =============================================================================
// Helpers
// =============================================================================

/**
 * Extracts the lowercased domain part of an email address.
 * Returns `null` when the input is null or has no `@`.
 */
function emailDomain(email: string | null): string | null {
  if (!email) return null
  const at = email.lastIndexOf('@')
  if (at === -1) return null
  return email.slice(at + 1).toLowerCase()
}

// =============================================================================
// Evaluator
// =============================================================================

/**
 * Pure function — no I/O. Returns a typed access decision.
 *
 * Execution order:
 * 1. Public portal → always granted.
 * 2. Team member (admin | member) → granted.
 * 3. Verified email on allowed-domain list → granted.
 * --- EXTENSION POINT: Phase N grant branches go here (invite, widget) ---
 * 4. No real session → unauthenticated (redirect to login).
 * 5. Authenticated but not team/domain → unauthorized (show access-denied screen).
 */
export function evaluatePortalAccess(ctx: PortalAccessContext): PortalAccessResult {
  // 1. Public portal — open to everyone.
  if (ctx.visibility !== 'private') {
    return { granted: true, reason: 'public' }
  }

  // 2. Team members always have access.
  if (ctx.role === 'admin' || ctx.role === 'member') {
    return { granted: true, reason: 'team' }
  }

  // 3. Verified email on the domain allowlist.
  //    emailVerified MUST be true — an unverified claim must not unlock access.
  if (ctx.isAuthenticated && ctx.emailVerified && ctx.allowedDomains.length > 0) {
    const domain = emailDomain(ctx.userEmail)
    if (domain && ctx.allowedDomains.includes(domain)) {
      return { granted: true, reason: 'domain' }
    }
  }

  // --- EXTENSION POINT ---
  // Phase N: invite-token / widget-grant checks go here similarly.
  // -------------------------

  // 4. No real authentication → redirect to login.
  if (!ctx.isAuthenticated) {
    return { granted: false, reason: 'unauthenticated' }
  }

  // 5. Authenticated but not a team member or allowed domain → show access-denied UI.
  return { granted: false, reason: 'unauthorized' }
}
