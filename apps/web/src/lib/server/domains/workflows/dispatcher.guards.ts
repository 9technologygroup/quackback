/**
 * Dispatcher guards (support platform §4.6, Slice 5d-ii): the two DB reads the
 * dispatcher consults before starting a run — the per-person frequency cap and
 * the customer_facing exclusive lock. Kept out of the dispatcher so its flow
 * (human gate, class split, first-match) unit-tests without a DB while the guards
 * are covered against a real one.
 */
import {
  db,
  and,
  eq,
  gte,
  inArray,
  count,
  workflows,
  workflowRuns,
  workflowRunEvents,
  type Workflow,
} from '@/lib/server/db'
import type { ConversationId, PrincipalId } from '@quackback/ids'

/** A workflow's per-person cap, read from trigger_settings. */
type FrequencyCap =
  | { type: 'unlimited' }
  | { type: 'once' }
  | { type: 'once_per_days'; days: number }
  | { type: 'n_total'; count: number }

/**
 * Whether a per-person frequency cap permits another run of `workflow` for
 * `subjectPrincipalId`. Caps count 'started' run events. No cap (or an anonymous
 * subject a per-person cap can't key on) is always allowed.
 */
export async function frequencyCapAllows(
  workflow: Workflow,
  subjectPrincipalId: PrincipalId | null
): Promise<boolean> {
  const cap = (workflow.triggerSettings as { frequencyCap?: FrequencyCap }).frequencyCap
  if (!cap || cap.type === 'unlimited') return true
  if (!subjectPrincipalId) return true

  const filters = [
    eq(workflowRunEvents.workflowId, workflow.id),
    eq(workflowRunEvents.subjectPrincipalId, subjectPrincipalId),
    eq(workflowRunEvents.kind, 'started'),
  ]
  if (cap.type === 'once_per_days') {
    filters.push(gte(workflowRunEvents.at, new Date(Date.now() - cap.days * 86_400_000)))
  }
  const [{ n }] = await db
    .select({ n: count() })
    .from(workflowRunEvents)
    .where(and(...filters))

  if (cap.type === 'n_total') return n < cap.count
  // once / once_per_days: allowed only with no prior run in scope.
  return n === 0
}

/**
 * Whether a customer_facing run is already live (running or waiting) on the
 * conversation — the exclusive lock. Background runs never lock, so the join
 * filters to customer_facing.
 */
export async function hasActiveCustomerFacingRun(conversationId: ConversationId): Promise<boolean> {
  const [row] = await db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .innerJoin(workflows, eq(workflowRuns.workflowId, workflows.id))
    .where(
      and(
        eq(workflowRuns.conversationId, conversationId),
        inArray(workflowRuns.state, ['running', 'waiting']),
        eq(workflows.class, 'customer_facing')
      )
    )
    .limit(1)
  return Boolean(row)
}
