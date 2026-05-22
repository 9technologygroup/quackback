/**
 * Moderation approval policy — UI mapping helpers.
 *
 * The stored policy is a single enum (`requireApproval`), but it is really
 * two independent questions: do anonymous submissions wait for review, and
 * do signed-in submissions wait for review. `none` is neither, `all` is
 * both. These helpers convert between the enum and the two-toggle UI so the
 * data model and server stay unchanged.
 */

/** The four workspace approval levels. */
export type RequireApprovalLevel = 'none' | 'anonymous' | 'authenticated' | 'all'

export interface ApprovalToggles {
  /** Hold posts from anonymous (no-account) submitters for review. */
  anonymous: boolean
  /** Hold posts from signed-in portal users for review. */
  authenticated: boolean
}

/** Enum -> the two-toggle UI state. */
export function requireApprovalToToggles(level: RequireApprovalLevel): ApprovalToggles {
  return {
    anonymous: level === 'anonymous' || level === 'all',
    authenticated: level === 'authenticated' || level === 'all',
  }
}

/** The two-toggle UI state -> enum. */
export function togglesToRequireApproval(toggles: ApprovalToggles): RequireApprovalLevel {
  if (toggles.anonymous && toggles.authenticated) return 'all'
  if (toggles.anonymous) return 'anonymous'
  if (toggles.authenticated) return 'authenticated'
  return 'none'
}
