/**
 * Workflow effectiveness reporting (support platform §4.6, §7). Read-only
 * aggregates over workflow_runs — runs started / completed / interrupted /
 * still-waiting per workflow over a date range, the effectiveness view the
 * support dashboard shows. `started` is the total (every run row); the rest are
 * the terminal/pending states.
 */
import { db, and, gte, lt, count, workflowRuns } from '@/lib/server/db'
import type { WorkflowId } from '@quackback/ids'

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
