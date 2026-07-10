/**
 * Workflow effectiveness reporting (support platform §4.6, §7). Read-only
 * aggregates over workflow_runs — runs started / completed / interrupted /
 * still-waiting per workflow over a date range, the effectiveness view the
 * support dashboard shows. `started` is the total (every run row); the rest are
 * the terminal/pending states.
 *
 * listWorkflowRuns / workflowRunTimeline (below) are the per-run drill-down a
 * failing workflow needs: workflow_run_events is written on every state
 * transition (workflow.engine.ts's logRunEvent) but had no read side until
 * now — the manager list only ever showed the trailing-7d started/completed
 * counts above.
 */
import {
  db,
  and,
  eq,
  gte,
  lt,
  count,
  desc,
  asc,
  workflowRuns,
  workflowRunEvents,
  type WorkflowRunState,
} from '@/lib/server/db'
import type { WorkflowId, WorkflowRunId, ConversationId } from '@quackback/ids'

export interface WorkflowEffectiveness {
  workflowId: WorkflowId
  started: number
  completed: number
  interrupted: number
  waiting: number
}

/** Per-workflow run counts by state over [from, to), keyed by workflow. */
export async function workflowEffectiveness(
  from: Date,
  to: Date
): Promise<WorkflowEffectiveness[]> {
  const rows = await db
    .select({ workflowId: workflowRuns.workflowId, state: workflowRuns.state, n: count() })
    .from(workflowRuns)
    .where(and(gte(workflowRuns.startedAt, from), lt(workflowRuns.startedAt, to)))
    .groupBy(workflowRuns.workflowId, workflowRuns.state)

  const byWorkflow = new Map<WorkflowId, WorkflowEffectiveness>()
  for (const row of rows) {
    const id = row.workflowId
    const entry = byWorkflow.get(id) ?? {
      workflowId: id,
      started: 0,
      completed: 0,
      interrupted: 0,
      waiting: 0,
    }
    entry.started += row.n
    if (row.state === 'done') entry.completed += row.n
    else if (row.state === 'interrupted') entry.interrupted += row.n
    else if (row.state === 'waiting') entry.waiting += row.n
    byWorkflow.set(id, entry)
  }
  return [...byWorkflow.values()]
}

/** The run-list drill-down default/ceiling: recent-first, capped so an
 *  old high-volume workflow's history doesn't try to render thousands of
 *  rows — a failing workflow's most recent runs are what an admin needs. */
export const WORKFLOW_RUN_LIST_LIMIT = 50

export interface WorkflowRunSummary {
  id: WorkflowRunId
  state: WorkflowRunState
  startedAt: Date
  endedAt: Date | null
  conversationId: ConversationId | null
}

/** A workflow's most recent runs, newest first, for the manager list's
 *  per-workflow drill-down. `limit` defaults to WORKFLOW_RUN_LIST_LIMIT. */
export async function listWorkflowRuns(
  workflowId: WorkflowId,
  limit: number = WORKFLOW_RUN_LIST_LIMIT
): Promise<WorkflowRunSummary[]> {
  return db
    .select({
      id: workflowRuns.id,
      state: workflowRuns.state,
      startedAt: workflowRuns.startedAt,
      endedAt: workflowRuns.endedAt,
      conversationId: workflowRuns.conversationId,
    })
    .from(workflowRuns)
    .where(eq(workflowRuns.workflowId, workflowId))
    .orderBy(desc(workflowRuns.startedAt))
    .limit(limit)
}

export interface WorkflowRunTimelineEntry {
  kind: string
  at: Date
}

/** One run's ordered event timeline (oldest first) — the raw `kind` strings
 *  logRunEvent wrote (started/waiting/completed/`action_failed:<type>`/
 *  swept_stale/swept_rescheduled); humanizing them into display text is a
 *  presentation concern left to the caller. */
export async function workflowRunTimeline(
  runId: WorkflowRunId
): Promise<WorkflowRunTimelineEntry[]> {
  return db
    .select({ kind: workflowRunEvents.kind, at: workflowRunEvents.at })
    .from(workflowRunEvents)
    .where(eq(workflowRunEvents.runId, runId))
    .orderBy(asc(workflowRunEvents.at))
}
