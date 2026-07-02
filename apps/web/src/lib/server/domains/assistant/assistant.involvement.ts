/**
 * Assistant involvement service — the audit/KPI unit for Quinn.
 *
 * One `assistant_involvements` row per conversation Quinn engages. The locked
 * outcome semantics (converged across the market references) live here as pure,
 * unit-tested functions; persistence is a thin layer over them. The inactivity
 * TIMER that drives an assumed resolution is wired in the next wave — this wave
 * only encodes the rule that decides whether one may be recorded.
 */
import {
  db,
  assistantInvolvements,
  and,
  eq,
  desc,
  type AssistantInvolvementSource,
  type AssistantInvolvementStatus,
  type AssistantInvolvementTrigger,
  type AssistantHandoffReason,
} from '@/lib/server/db'
import type { Executor } from '@/lib/server/domains/principals/principal.factory'
import type { AssistantInvolvementId, ConversationId } from '@quackback/ids'

export type AssistantInvolvement = typeof assistantInvolvements.$inferSelect

/**
 * Default inactivity window before an unanswered-back thread is assumed
 * resolved (~minutes). The timer that trips it rides the next wave; exported so
 * that wiring reuses this single source.
 */
export const ASSUMED_RESOLUTION_INACTIVITY_MINUTES = 30

// --------------------------------------------------------------- pure rules ---

/** Context the outcome rules reason over (all supplied by the caller). */
export interface OutcomeContext {
  /** Quinn produced a substantive answer this involvement (a greeting is not one). */
  gaveRealAnswer: boolean
  /** Minutes since the customer's last activity after Quinn's real answer. */
  inactivityMinutes: number
  /** The customer came back needing help after the assumed window. */
  customerReturned: boolean
}

/**
 * Whether an assumed resolution may be recorded: only after a real answer,
 * only past the inactivity window, and never once the customer has returned
 * needing help (which voids it).
 */
export function assumedResolutionEligible(
  ctx: OutcomeContext,
  thresholdMinutes: number = ASSUMED_RESOLUTION_INACTIVITY_MINUTES
): boolean {
  if (!ctx.gaveRealAnswer) return false
  if (ctx.customerReturned) return false
  return ctx.inactivityMinutes >= thresholdMinutes
}

/** Whether a confirmed resolution may be recorded: a real answer the customer explicitly affirmed. */
export function confirmedResolutionEligible(ctx: {
  gaveRealAnswer: boolean
  explicitAffirmation: boolean
}): boolean {
  return ctx.gaveRealAnswer && ctx.explicitAffirmation
}

/** The terminal status for a recorded outcome. */
export function outcomeStatus(kind: 'confirmed' | 'assumed'): AssistantInvolvementStatus {
  return kind === 'confirmed' ? 'resolved_confirmed' : 'resolved_assumed'
}

// -------------------------------------------------------------- persistence ---

/** Open a fresh involvement for a conversation Quinn is engaging. */
export async function openInvolvement(
  input: { conversationId: ConversationId; triggeredBy: AssistantInvolvementTrigger },
  exec: Executor = db
): Promise<AssistantInvolvement> {
  const [row] = await exec
    .insert(assistantInvolvements)
    .values({ conversationId: input.conversationId, triggeredBy: input.triggeredBy })
    .returning()
  return row
}

/** The currently-active involvement for a conversation, or null. */
export async function getActiveInvolvement(
  conversationId: ConversationId,
  exec: Executor = db
): Promise<AssistantInvolvement | null> {
  const [row] = await exec
    .select()
    .from(assistantInvolvements)
    .where(
      and(
        eq(assistantInvolvements.conversationId, conversationId),
        eq(assistantInvolvements.status, 'active')
      )
    )
    .orderBy(desc(assistantInvolvements.createdAt))
    .limit(1)
  return row ?? null
}

/** Persist the sources Quinn cited on an involvement. */
export async function setInvolvementSources(
  id: AssistantInvolvementId,
  sources: AssistantInvolvementSource[],
  exec: Executor = db
): Promise<void> {
  await exec.update(assistantInvolvements).set({ sources }).where(eq(assistantInvolvements.id, id))
}

/** Record a hand-off: Quinn decided THAT it escalates and why (never WHERE). */
export async function recordHandoff(
  id: AssistantInvolvementId,
  reason: AssistantHandoffReason,
  exec: Executor = db
): Promise<void> {
  await exec
    .update(assistantInvolvements)
    .set({ status: 'handed_off', handoffReason: reason, endedAt: new Date() })
    .where(eq(assistantInvolvements.id, id))
}

/**
 * Record a resolution outcome — at most one per conversation. Returns the
 * updated row, or null if a terminal outcome was already recorded (the
 * at-most-one guard, enforced with a conditional UPDATE so concurrent callers
 * cannot double-record).
 */
export async function recordOutcome(
  id: AssistantInvolvementId,
  kind: 'confirmed' | 'assumed',
  exec: Executor = db
): Promise<AssistantInvolvement | null> {
  const [row] = await exec
    .update(assistantInvolvements)
    .set({ status: outcomeStatus(kind), endedAt: new Date() })
    .where(
      and(
        eq(assistantInvolvements.id, id),
        // Only a non-terminal involvement can be resolved (at most one outcome).
        eq(assistantInvolvements.status, 'active')
      )
    )
    .returning()
  return row ?? null
}

/** Void an assumed resolution when the customer returns needing help. */
export async function voidAssumedResolution(
  id: AssistantInvolvementId,
  exec: Executor = db
): Promise<void> {
  await exec
    .update(assistantInvolvements)
    .set({ status: 'active', endedAt: null })
    .where(
      and(eq(assistantInvolvements.id, id), eq(assistantInvolvements.status, 'resolved_assumed'))
    )
}

/** Attach a CSAT rating (recorded when Quinn was the last handler). */
export async function setInvolvementRating(
  id: AssistantInvolvementId,
  rating: number,
  exec: Executor = db
): Promise<void> {
  await exec.update(assistantInvolvements).set({ rating }).where(eq(assistantInvolvements.id, id))
}
