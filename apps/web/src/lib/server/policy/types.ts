/**
 * Central policy types.
 *
 * Every policy module exposes two complementary functions per resource:
 *   - canX(actor, resource): Decision      — single-row authorization
 *   - xFilter(actor): SQL predicate         — list-query authorization
 *
 * Decisions are an explicit discriminated union so the deny case
 * always carries a machine-readable reason for logging and UI hints.
 */
import type { PrincipalId, SegmentId } from '@quackback/ids'

export type Role = 'admin' | 'member' | 'user'
export type PrincipalType = 'user' | 'anonymous' | 'service'

export interface Actor {
  principalId: PrincipalId | null
  role: Role | null
  /** `'anonymous'` for unsigned portal sessions; never collapse to `'user'`. */
  principalType: PrincipalType
  /** Segment memberships resolved once per request and threaded through policy. */
  segmentIds: ReadonlySet<SegmentId>
}

export type Decision = { allowed: true } | { allowed: false; reason: string }

export function allowDecision(): Decision {
  return { allowed: true }
}

export function denyDecision(reason: string): Decision {
  return { allowed: false, reason }
}

export function isAllowed(decision: Decision): boolean {
  return decision.allowed
}

/** Anonymous actor — used by public portal pages and unsigned widget requests. */
export const ANONYMOUS_ACTOR: Actor = {
  principalId: null,
  role: null,
  principalType: 'anonymous',
  segmentIds: new Set(),
}
