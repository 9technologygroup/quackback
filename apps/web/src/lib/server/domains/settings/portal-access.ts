/**
 * Portal-level access evaluation.
 *
 * Decides whether a visitor may render the portal, based on the workspace's
 * configured visibility and the visitor's authentication state.
 *
 * Phase 1: team-only gate (admin | member always pass).
 * Phase 2: allowed email-domain grant (verified email required).
 * Phase 3: accepted portal email-invite grant (verified email required).
 * Phase 4: widget sign-in grant (any portal-signed-in user when admin enables widgetSignIn).
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
  /**
   * True when the visitor has a portal invitation row with status='accepted'
   * whose email matches their verified session email.
   *
   * Populated by the resolver via a DB lookup. Defaults to `false` so callers
   * that don't consult the invite table (e.g. the widget gate, legacy code)
   * remain valid without changes.
   */
  hasAcceptedPortalInvite?: boolean
  /**
   * True when the workspace admin has enabled widget sign-in on this
   * private portal. When set, any portal-signed-in user (role='user')
   * gains access — the widget mints an OTT and the portal's OttHandler
   * exchanges it for a session cookie. Defaults to `false`.
   */
  widgetSignInEnabled?: boolean
}

/** Discriminated union — narrows cleanly in if/switch. */
export type PortalAccessResult =
  | { granted: true; reason: 'public' | 'team' | 'domain' | 'invite' | 'widget' }
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
 * 4. Accepted portal invite (email match, verified) → granted.
 * 5. Widget sign-in enabled + authenticated portal user → granted.
 * 6. No real session → unauthenticated (redirect to login).
 * 7. Authenticated but no matching grant → unauthorized (show access-denied screen).
 *
 * Ordering: team > domain > invite > widget. The widget branch is intentionally
 * last among grant paths so that a more-specific grant (team, domain, invite)
 * is preferred when the user qualifies for multiple paths. The widget branch
 * admits any role='user' principal when widgetSignInEnabled — sign-in happens
 * via the one-time-token flow (widget mints OTT, portal OttHandler sets session).
 */
export function evaluatePortalAccess(ctx: PortalAccessContext): PortalAccessResult {
  // 1. Public portal — open to everyone.
  if (ctx.visibility !== 'private') {
    return { granted: true, reason: 'public' }
  }

  // 2. Team members always have access — but only when actually authenticated.
  //    An anonymous principal carrying a team role must not bypass the gate.
  if (ctx.isAuthenticated && (ctx.role === 'admin' || ctx.role === 'member')) {
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

  // 4. Accepted portal invite.
  //    emailVerified MUST be true — same reasoning as the domain branch above.
  if (ctx.isAuthenticated && ctx.emailVerified && (ctx.hasAcceptedPortalInvite ?? false)) {
    return { granted: true, reason: 'invite' }
  }

  // 5. Widget sign-in grant.
  //    When the admin enables widgetSignIn, any portal-signed-in user (role='user')
  //    gets in. Sign-in happens via the one-time-token flow initiated from the widget.
  //    Anonymous principals do NOT qualify — isAuthenticated must be true.
  if ((ctx.widgetSignInEnabled ?? false) && ctx.isAuthenticated && ctx.role === 'user') {
    return { granted: true, reason: 'widget' }
  }

  // 6. No real authentication → redirect to login.
  if (!ctx.isAuthenticated) {
    return { granted: false, reason: 'unauthenticated' }
  }

  // 7. Authenticated but no matching grant → show access-denied UI.
  return { granted: false, reason: 'unauthorized' }
}
