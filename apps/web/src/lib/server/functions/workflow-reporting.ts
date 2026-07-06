/**
 * Workflow run metrics for the workflows manager list (support platform §4.6).
 * Distinct from `support-reporting.ts`'s analytics-dashboard version: that one
 * gates on `analytics.view` for the reporting surface, while the manager list
 * is gated on `routing.manage` (the same permission `listWorkflowsFn` reads
 * behind), so anyone who can see the workflow list can see its run counts.
 */
import { createServerFn } from '@tanstack/react-start'
import { requireAuth } from './auth-helpers'
import { PERMISSIONS } from '@/lib/shared/permissions'
import { workflowEffectiveness } from '@/lib/server/domains/workflows/workflow-reporting'

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

export interface WorkflowEffectivenessRow {
  workflowId: string
  started: number
  completed: number
}

/** Runs started/completed per workflow over the trailing 7 days. */
export const workflowEffectivenessFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<WorkflowEffectivenessRow[]> => {
    await requireAuth({ permission: PERMISSIONS.ROUTING_MANAGE })
    const to = new Date()
    const from = new Date(to.getTime() - SEVEN_DAYS_MS)
    return (await workflowEffectiveness(from, to)).map((row) => ({
      workflowId: row.workflowId as string,
      started: row.started,
      completed: row.completed,
    }))
  }
)
