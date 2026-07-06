/**
 * Copilot usage + outcome reporting (P2-D.2): questions asked, transforms run
 * (per kind), on-demand summaries generated, and the propose-approve-execute
 * actions funnel, over a date range — the fifth independent bounded scan on
 * the assistant admin page, alongside SupportPerformanceCard,
 * QuinnPerformanceCard, QuinnToolsCard, and GuidanceRulesCard. Consolidating
 * these five into a rollup table (the analytics_daily_stats pattern) is
 * deliberately deferred until admin-page latency actually hurts: every one of
 * them is a window-bounded scan riding an index, the same "low volume, no
 * rollup" call quinn-performance.ts and quinn-tools.ts already made.
 *
 * Data sources:
 *  - `ai_usage_log` rows with `pipelineStep: 'assistant'` and
 *    `metadata.surface: 'copilot'` are questions asked through the Copilot
 *    Q&A sidebar (assistant.runtime.ts's `runAssistantTurn`, called from
 *    routes/api/admin/assistant/copilot.ts). `metadata.principalId` (also
 *    added there) attributes a turn to the asking teammate for the
 *    per-teammate breakdown; older rows logged before that field existed
 *    simply carry no `principalId` key and are excluded from that breakdown
 *    (same graceful-absence handling guidance-stats.ts uses for
 *    `guidanceRuleIds`).
 *  - `ai_usage_log` rows with `pipelineStep: 'copilot_transform'` are
 *    tone/format rewrites (copilot-transform.ts's `runCopilotTransform`),
 *    with `metadata.transform` already carrying the transform kind.
 *  - `ai_usage_log` rows with `pipelineStep: 'copilot_summary'` are on-demand
 *    "Summarize" chip calls (conversation-summary.service.ts's
 *    `generateConversationSummaryText`) — this call had no usage-log entry
 *    at all before this feature; it's added there specifically so this
 *    report can count it.
 *  - `assistant_pending_actions` rows are the act-on-approval funnel
 *    (pending-actions.service.ts): every proposal in range counts toward
 *    `actionsProposed`; `actionsApproved` counts a proposal as approved for
 *    the lifetime of that decision even after it later settles into
 *    `executed`/`failed` (only an `approved` row can reach either — see
 *    `settleApprovedAction`), since the report cares whether a human said
 *    yes, not whether the tool call that followed happened to succeed.
 *
 * Multiple attempts of the SAME logical turn (a synthesis retry) each log
 * their own `ai_usage_log` row, so a turn that needed a retry is counted more
 * than once here — the same granularity guidance-stats.ts already accepts for
 * its "used" count, rather than a new precision this report invents.
 *
 * Indexes ridden: `ai_usage_log_step_idx` (pipelineStep) and
 * `ai_usage_log_created_idx` (createdAt) for every ai_usage_log query here
 * (the metadata->>'surface'/'transform'/'principalId' filters aren't
 * indexed and run as a Filter over whichever the planner picks — the same
 * shape guidance-stats.ts's own bounded scan already accepts); the new
 * `assistant_pending_actions_proposed_at_idx` (migration 0174) for the
 * actions-funnel scan, added because that table previously had no plain
 * `proposed_at` index at all.
 */
import { db, and, eq, gte, lt, sql, aiUsageLog, assistantPendingActions } from '@/lib/server/db'
import type { PrincipalId } from '@quackback/ids'
import { loadAuthors } from '@/lib/server/domains/principals/principal-display'
import { ratePctOrNull } from '@/lib/shared/percent'

/** Cap on the per-teammate leaderboard — a glance-level card, not a full report. */
const TOP_TEAMMATES_LIMIT = 10

export interface CopilotTransformKindCount {
  /** Raw `metadata.transform` value (a `TransformKind`, kept as a string here
   *  so a legacy/unrecognized value is still reported rather than dropped). */
  transform: string
  count: number
}

export interface CopilotTeammateQuestionCount {
  principalId: PrincipalId
  displayName: string | null
  questions: number
}

export interface CopilotUsageMetrics {
  /** Copilot Q&A turns asked in the range (ai_usage_log, surface: copilot). */
  totalQuestions: number
  /** Tone/format transforms run in the range. */
  totalTransforms: number
  /** Per-kind breakdown of totalTransforms (my_tone, more_friendly, ...). */
  transformsByKind: CopilotTransformKindCount[]
  /** On-demand "Summarize" chip calls in the range. */
  totalSummaries: number
  /** Write-tool proposals opened in the range, any current status. */
  actionsProposed: number
  /** Of those, the ones a teammate approved (including ones since executed or failed). */
  actionsApproved: number
  /** Of those, the ones a teammate rejected. */
  actionsRejected: number
  /** Of those, the ones nobody decided before the TTL swept them. */
  actionsExpired: number
  /** actionsApproved / actionsProposed, 0-100; null (never NaN) when nothing was proposed. */
  approvalRate: number | null
  /** Top teammates by question volume, most first, capped at 10. */
  perTeammate: CopilotTeammateQuestionCount[]
}

interface PendingActionBucketRow {
  total: number
  approved: number
  rejected: number
  expired: number
}

/**
 * Fold the independently-queried aggregates into the final report shape.
 * Pure — the date-bounded SQL lives in `getCopilotUsageMetrics` below; this is
 * what's unit-tested directly for the rate math and the transform total.
 */
export function summarizeCopilotUsage(
  totalQuestions: number,
  transformsByKind: CopilotTransformKindCount[],
  totalSummaries: number,
  actionBucket: PendingActionBucketRow,
  perTeammate: CopilotTeammateQuestionCount[]
): CopilotUsageMetrics {
  const totalTransforms = transformsByKind.reduce((sum, row) => sum + row.count, 0)
  return {
    totalQuestions,
    totalTransforms,
    transformsByKind,
    totalSummaries,
    actionsProposed: actionBucket.total,
    actionsApproved: actionBucket.approved,
    actionsRejected: actionBucket.rejected,
    actionsExpired: actionBucket.expired,
    approvalRate: ratePctOrNull(actionBucket.approved, actionBucket.total),
    perTeammate,
  }
}

/** `metadata->>'surface' = 'copilot'` for an aiUsageLog row — the one signal
 *  that distinguishes a Copilot Q&A turn from every other assistant surface. */
const isCopilotSurface = sql`${aiUsageLog.metadata}->>'surface' = 'copilot'`

/**
 * Query + summarize Copilot usage over [from, to). Five independent scans
 * (questions count, transforms grouped by kind, summaries count, pending
 * actions grouped by outcome bucket, per-teammate top 10) run in parallel;
 * see this module's doc comment for the indexes each rides.
 */
export async function getCopilotUsageMetrics(from: Date, to: Date): Promise<CopilotUsageMetrics> {
  // Every ai_usage_log query below bounds on this same [from, to) window;
  // computed once since the column and range never vary across them.
  const usageLogInRange = and(gte(aiUsageLog.createdAt, from), lt(aiUsageLog.createdAt, to))

  const [questionsRows, transformRows, summariesRows, actionRows, teammateRows] = await Promise.all(
    [
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(aiUsageLog)
        .where(and(eq(aiUsageLog.pipelineStep, 'assistant'), isCopilotSurface, usageLogInRange)),

      db
        .select({
          transform: sql<string>`metadata->>'transform'`,
          n: sql<number>`count(*)::int`,
        })
        .from(aiUsageLog)
        .where(
          and(
            eq(aiUsageLog.pipelineStep, 'copilot_transform'),
            sql`metadata->>'transform' IS NOT NULL`,
            usageLogInRange
          )
        )
        .groupBy(sql`metadata->>'transform'`),

      db
        .select({ n: sql<number>`count(*)::int` })
        .from(aiUsageLog)
        .where(and(eq(aiUsageLog.pipelineStep, 'copilot_summary'), usageLogInRange)),

      db
        .select({
          total: sql<number>`count(*)::int`,
          approved: sql<number>`count(*) filter (where ${assistantPendingActions.status} in ('approved','executed','failed'))::int`,
          rejected: sql<number>`count(*) filter (where ${assistantPendingActions.status} = 'rejected')::int`,
          expired: sql<number>`count(*) filter (where ${assistantPendingActions.status} = 'expired')::int`,
        })
        .from(assistantPendingActions)
        .where(
          and(
            gte(assistantPendingActions.proposedAt, from),
            lt(assistantPendingActions.proposedAt, to)
          )
        ),

      db
        .select({
          principalId: sql<string>`metadata->>'principalId'`,
          n: sql<number>`count(*)::int`,
        })
        .from(aiUsageLog)
        .where(
          and(
            eq(aiUsageLog.pipelineStep, 'assistant'),
            isCopilotSurface,
            sql`metadata->>'principalId' IS NOT NULL`,
            usageLogInRange
          )
        )
        .groupBy(sql`metadata->>'principalId'`)
        .orderBy(sql`count(*) DESC`, sql`metadata->>'principalId' ASC`)
        .limit(TOP_TEAMMATES_LIMIT),
    ]
  )

  const authors = await loadAuthors(teammateRows.map((row) => row.principalId as PrincipalId))
  const perTeammate: CopilotTeammateQuestionCount[] = teammateRows.map((row) => {
    const principalId = row.principalId as PrincipalId
    return {
      principalId,
      displayName: authors.get(principalId)?.displayName ?? null,
      questions: row.n,
    }
  })

  const actionBucket: PendingActionBucketRow = actionRows[0] ?? {
    total: 0,
    approved: 0,
    rejected: 0,
    expired: 0,
  }

  return summarizeCopilotUsage(
    questionsRows[0]?.n ?? 0,
    transformRows.map((row) => ({ transform: row.transform, count: row.n })),
    summariesRows[0]?.n ?? 0,
    actionBucket,
    perTeammate
  )
}
