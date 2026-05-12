/**
 * Single write path for segment membership.
 *
 * All four ingestion sources (manual / sso / widget / api) plus the
 * dynamic-segment evaluator flow through here so audit events fire
 * consistently and reconcile logic can stay simple.
 *
 * Source-priority guard inside addMember prevents demotion: a manual
 * admin assignment will never be overwritten by a subsequent SSO claim,
 * and reconcileSsoMemberships can therefore safely delete only the
 * rows whose addedBy is still 'sso'.
 */
import { db, userSegments, eq, and, inArray } from '@/lib/server/db'
import { recordAuditEvent, type AuditActor } from '@/lib/server/audit/log'
import type { PrincipalId, SegmentId } from '@quackback/ids'

export type MembershipSource = 'manual' | 'sso' | 'widget' | 'api' | 'dynamic'

/**
 * Source-precedence: higher wins on conflict. Manual admin intent is
 * the most durable assertion; SSO and dynamic are volatile.
 *
 *   manual > api > widget > sso > dynamic
 */
const SOURCE_PRIORITY: Record<MembershipSource, number> = {
  manual: 5,
  api: 4,
  widget: 3,
  sso: 2,
  dynamic: 1,
}

export interface AddMemberInput {
  principalId: PrincipalId
  segmentId: SegmentId
  source: MembershipSource
  actor: AuditActor | null
  request?: Request
}

export async function addMember(input: AddMemberInput): Promise<void> {
  const existing = await db
    .select({ addedBy: userSegments.addedBy })
    .from(userSegments)
    .where(
      and(
        eq(userSegments.principalId, input.principalId),
        eq(userSegments.segmentId, input.segmentId)
      )
    )

  if (existing.length === 0) {
    await db.insert(userSegments).values({
      principalId: input.principalId,
      segmentId: input.segmentId,
      addedBy: input.source,
    })
  } else {
    const existingPriority = SOURCE_PRIORITY[existing[0].addedBy as MembershipSource]
    const newPriority = SOURCE_PRIORITY[input.source]
    if (newPriority > existingPriority) {
      await db
        .update(userSegments)
        .set({ addedBy: input.source })
        .where(
          and(
            eq(userSegments.principalId, input.principalId),
            eq(userSegments.segmentId, input.segmentId)
          )
        )
    }
    // Otherwise keep the stickier source untouched.
  }

  if (input.actor) {
    await recordAuditEvent({
      event: 'segment.member.added',
      actor: input.actor,
      request: input.request,
      target: { type: 'segment', id: input.segmentId },
      metadata: { principalId: input.principalId, source: input.source },
    })
  }
}

export interface RemoveMemberInput {
  principalId: PrincipalId
  segmentId: SegmentId
  actor: AuditActor | null
  request?: Request
}

export async function removeMember(input: RemoveMemberInput): Promise<void> {
  await db
    .delete(userSegments)
    .where(
      and(
        eq(userSegments.principalId, input.principalId),
        eq(userSegments.segmentId, input.segmentId)
      )
    )
  if (input.actor) {
    await recordAuditEvent({
      event: 'segment.member.removed',
      actor: input.actor,
      request: input.request,
      target: { type: 'segment', id: input.segmentId },
      metadata: { principalId: input.principalId },
    })
  }
}

/**
 * Reconcile SSO-sourced memberships for a principal against the IdP
 * claim.
 *
 * - Removes rows where addedBy='sso' AND the segment is no longer in
 *   the claim. The addedBy='sso' guard keeps manual/widget/api
 *   memberships safe even if the claim drops them.
 * - For each segment in the claim, calls addMember(..., 'sso'). The
 *   source-priority guard makes that a no-op when a stickier
 *   (manual/api/widget) membership already exists.
 */
export async function reconcileSsoMemberships(input: {
  principalId: PrincipalId
  desiredSegmentIds: SegmentId[]
}): Promise<void> {
  const existing = await db
    .select()
    .from(userSegments)
    .where(and(eq(userSegments.principalId, input.principalId), eq(userSegments.addedBy, 'sso')))

  const existingIds = new Set(existing.map((r) => r.segmentId))
  const desiredIds = new Set(input.desiredSegmentIds)

  const toRemove = [...existingIds].filter((id) => !desiredIds.has(id as SegmentId))
  const toAdd = [...desiredIds].filter((id) => !existingIds.has(id))

  if (toRemove.length > 0) {
    await db
      .delete(userSegments)
      .where(
        and(
          eq(userSegments.principalId, input.principalId),
          eq(userSegments.addedBy, 'sso'),
          inArray(userSegments.segmentId, toRemove as never[])
        )
      )
  }
  for (const segmentId of toAdd) {
    await addMember({
      principalId: input.principalId,
      segmentId: segmentId as SegmentId,
      source: 'sso',
      actor: null,
    })
  }
}

/**
 * Resolve a principal's segment memberships for use in policy decisions.
 * Cache at the request level — do not call once per row.
 */
export async function segmentIdsForPrincipal(
  principalId: PrincipalId | null
): Promise<ReadonlySet<SegmentId>> {
  if (!principalId) return new Set()
  const rows = await db
    .select({ segmentId: userSegments.segmentId })
    .from(userSegments)
    .where(eq(userSegments.principalId, principalId))
  return new Set(rows.map((r) => r.segmentId as SegmentId))
}
